package common

import (
	"context"
	"fmt"
	"os"
	"time"

	"code.byted.org/iaasng/lumi-cua-go-sdk/src/lumi_cua_sdk"
)

const (
	DefaultManagerURL = "https://iaas-cua-devbox-ecs-manager-v2.byted.org/mgr"
	DefaultPlannerURL = "https://iaas-cua-devbox-planner-agent.byted.org/planner"

	TaskTimeoutSeconds = 300
	IdlePollInterval   = 5 * time.Second
	MaxIdleWaitTime    = 90 * time.Second
)

// InitCUAClient 初始化 Lumi CUA 客户端
func InitCUAClient() *lumi_cua_sdk.LumiCuaClient {
	managerURL := EnvOrDefault("LUMI_MANAGER_URL", DefaultManagerURL)
	plannerURL := EnvOrDefault("LUMI_PLANNER_URL", DefaultPlannerURL)
	apiKey := EnvRequired("LUMI_API_KEY")
	return lumi_cua_sdk.NewLumiCuaClient(managerURL, plannerURL, apiKey)
}

// GetAvailableSandbox 获取第一个可用沙箱
func GetAvailableSandbox(ctx context.Context, client *lumi_cua_sdk.LumiCuaClient) (*lumi_cua_sdk.Sandbox, error) {
	sandboxes, err := client.ListSandboxes(ctx)
	if err != nil {
		return nil, fmt.Errorf("获取沙箱列表失败: %v", err)
	}
	if len(sandboxes) == 0 {
		return nil, fmt.Errorf("没有可用的沙箱，请先创建一个远程沙箱")
	}
	return sandboxes[0], nil
}

// WaitForIdle 等待沙箱空闲
func WaitForIdle(ctx context.Context, client *lumi_cua_sdk.LumiCuaClient, sandboxID string) error {
	startTime := time.Now()
	for {
		isIdle, err := client.CheckIdle(ctx, sandboxID)
		if err != nil {
			fmt.Fprintf(os.Stderr, "检查空闲状态失败: %v\n", err)
		}
		if isIdle {
			return nil
		}
		if time.Since(startTime) > MaxIdleWaitTime {
			return fmt.Errorf("等待 Planner 空闲超时（>%v）", MaxIdleWaitTime)
		}
		time.Sleep(IdlePollInterval)
	}
}

// SelectModel 选择第一个可用模型
func SelectModel(ctx context.Context, client *lumi_cua_sdk.LumiCuaClient, sandboxID string) (string, error) {
	models, err := client.ListModels(ctx, sandboxID)
	if err != nil {
		return "", fmt.Errorf("获取模型列表失败: %v", err)
	}
	if len(models) == 0 {
		return "", fmt.Errorf("没有可用的模型")
	}
	return models[0].Name, nil
}

// RunTask 执行 CUA 任务，返回执行步数
func RunTask(ctx context.Context, client *lumi_cua_sdk.LumiCuaClient, prompt, sandboxID, model string) (int, error) {
	messageChan, err := client.RunTask(ctx, prompt, sandboxID, model, "", "enabled", TaskTimeoutSeconds)
	if err != nil {
		if taskBusyErr, ok := err.(*lumi_cua_sdk.TaskBusyError); ok {
			return 0, fmt.Errorf("沙箱繁忙: %v", taskBusyErr)
		}
		return 0, fmt.Errorf("启动任务失败: %v", err)
	}

	steps := 0
	for message := range messageChan {
		steps++
		fmt.Fprintf(os.Stderr, "[步骤 %d] %s | %s\n", steps, message.Action, message.Summary)

		switch message.Action {
		case "error":
			return steps, fmt.Errorf("执行出错（步骤 %d）: %s", steps, message.Summary)
		case "timeout":
			return steps, fmt.Errorf("任务超时（%ds）", TaskTimeoutSeconds)
		}
	}
	return steps, nil
}
