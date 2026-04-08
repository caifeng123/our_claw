// upload.mjs — CDN 图片上传工具（Windows/Linux 通用）
// 用法:
//   node upload.mjs <图片路径>                                  → 上传单张
//   node upload.mjs <图片1> <图片2> ...                         → 批量上传
//   node upload.mjs --dir images/taskid123 <目录路径>           → 上传目录下所有图片
//   node upload.mjs --dir images/taskid123 --email x@y.com ... → 指定 CDN 邮箱
//
// 输出格式 (stdout JSON):
//   单张: {"success":true,"file":"a.png","cdnUrl":"https://..."}
//   批量: [{"success":true,"file":"a.png","cdnUrl":"https://..."},...]
//
// 放置位置: C:\Users\ecs\Desktop\tools\upload.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, resolve, join } from 'node:path';

// ==================== 默认配置 ====================
const CDN_UPLOAD_URL = 'https://ife.bytedance.net/cdn/upload';
const DEFAULT_CONFIG = {
  dir: 'test',
  region: 'CN',
  email: 'caifeng.nice@bytedance.com',
};

// ==================== CDN 上传 ====================
export async function uploadImage(filePath, options = {}) {
  const dir = options.dir || DEFAULT_CONFIG.dir;
  const region = options.region || DEFAULT_CONFIG.region;
  const email = options.email || DEFAULT_CONFIG.email;

  const filename = `${Date.now() / 1000 | 0}_${basename(filePath)}`;
  const buffer = readFileSync(filePath);
  const blob = new Blob([buffer], { type: 'application/octet-stream' });

  const formData = new FormData();
  formData.append('dir', dir);
  formData.append('region', region);
  formData.append('email', email);
  formData.append('file', blob, filename);

  const response = await fetch(CDN_UPLOAD_URL, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`上传失败 [${response.status}]: ${response.statusText}`);
  }

  const result = await response.json();
  if (!result.cdnUrl) {
    throw new Error(`CDN 未返回 URL: ${JSON.stringify(result)}`);
  }

  // cdnUrl 可能不含 https://，补全
  let cdnUrl = result.cdnUrl;
  if (!cdnUrl.startsWith('http')) {
    cdnUrl = 'https://' + cdnUrl;
  }
  return cdnUrl;
}

// ==================== 批量上传目录下所有图片 ====================
export async function uploadDirectory(dirPath, options = {}) {
  const imageExts = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];
  const files = readdirSync(dirPath)
    .filter(f => imageExts.some(ext => f.toLowerCase().endsWith(ext)))
    .map(f => join(dirPath, f));

  if (files.length === 0) {
    return [];
  }

  const results = [];
  for (const filePath of files) {
    try {
      const cdnUrl = await uploadImage(filePath, options);
      results.push({ success: true, file: basename(filePath), cdnUrl });
    } catch (err) {
      results.push({ success: false, file: basename(filePath), error: err.message });
    }
  }
  return results;
}

// ==================== CLI ====================
async function main() {
  const args = process.argv.slice(2);

  // 解析命名参数
  let dirOverride = null;
  let emailOverride = null;
  let regionOverride = null;
  const filteredArgs = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir' && i + 1 < args.length) {
      dirOverride = args[++i];
    } else if (args[i] === '--email' && i + 1 < args.length) {
      emailOverride = args[++i];
    } else if (args[i] === '--region' && i + 1 < args.length) {
      regionOverride = args[++i];
    } else {
      filteredArgs.push(args[i]);
    }
  }

  if (filteredArgs.length === 0) {
    console.error('用法:');
    console.error('  node upload.mjs [--dir <cdn子目录>] [--email <邮箱>] [--region <区域>] <图片路径|目录路径> [...]');
    console.error('');
    console.error('参数:');
    console.error('  --dir     CDN 子目录（默认: test）');
    console.error('  --email   CDN 关联邮箱（默认: caifeng.nice@bytedance.com）');
    console.error('  --region  CDN 区域（默认: CN）');
    console.error('');
    console.error('示例:');
    console.error('  node upload.mjs photo.png');
    console.error('  node upload.mjs --dir images/task123 --email x@y.com photo1.png photo2.png');
    console.error('  node upload.mjs --dir images/task123 C:\\Users\\ecs\\Desktop\\temp\\task123\\output');
    process.exit(1);
  }

  // 构建 options
  const options = {};
  if (dirOverride) options.dir = dirOverride;
  if (emailOverride) options.email = emailOverride;
  if (regionOverride) options.region = regionOverride;

  // 判断是单文件、多文件还是目录
  const results = [];

  for (const inputPath of filteredArgs) {
    const resolved = resolve(inputPath);
    try {
      const stat = statSync(resolved);
      if (stat.isDirectory()) {
        // 目录模式：上传目录下所有图片
        const dirResults = await uploadDirectory(resolved, options);
        results.push(...dirResults);
      } else {
        // 文件模式
        const cdnUrl = await uploadImage(resolved, options);
        results.push({ success: true, file: basename(resolved), cdnUrl });
      }
    } catch (err) {
      results.push({ success: false, file: basename(resolved), error: err.message });
    }
  }

  // 输出 JSON 到 stdout
  if (results.length === 1) {
    console.log(JSON.stringify(results[0], null, 2));
  } else {
    console.log(JSON.stringify(results, null, 2));
  }
}

main().catch(err => {
  console.error(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
});