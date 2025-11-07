const express = require('express');
const cors = require('cors');
const YTDlpWrap = require('yt-dlp-wrap').default;
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { execSync } = require('child_process'); // <-- FIX 1: Added missing import

const app = express();

let ytDlpPath = 'yt-dlp';

try {
  execSync('which yt-dlp', { stdio: 'pipe' });
  console.log('✅ yt-dlp found in system');
} catch (error) {
  try {
    console.log('⚠️ Installing yt-dlp...');
    execSync('pip install yt-dlp || pip3 install yt-dlp', { stdio: 'inherit' });
    console.log('✅ yt-dlp installed successfully');
  } catch (installError) {
    console.error('❌ Failed to install yt-dlp:', installError.message);
  }
}

const ytDlp = new YTDlpWrap();

app.use(cors());
app.use(express.json());

const unlinkAsync = promisify(fs.unlink);

// Create temp directory
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR);
  console.log('📁 Created temp directory:', TEMP_DIR);
}

// Clean old temp files on startup
function cleanTempFiles() {
  fs.readdir(TEMP_DIR, (err, files) => {
    if (err) return;
    files.forEach(file => {
      const filePath = path.join(TEMP_DIR, file);
      const stats = fs.statSync(filePath);
      const now = Date.now();
      const fileAge = now - stats.mtimeMs;
      if (fileAge > 3600000) {
        fs.unlink(filePath, () => {});
      }
    });
  });
}

cleanTempFiles();
setInterval(cleanTempFiles, 1800000);

// Helper function to add cookie arguments
function addCookieArgs(args, platform) {
  if (platform === 'instagram' || platform === 'tiktok') {
    const cookiePath = path.join(__dirname, 'cookies.txt');
    
    if (fs.existsSync(cookiePath)) {
      args.push('--cookies', cookiePath);
      console.log('🍪 Using cookies.txt file');
      return 'file';
    } else {
      console.log('⚠️ No cookies.txt found - Instagram/TikTok will likely fail');
      console.log('💡 Get extension: https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc');
      // Don't add cookie args - will try without authentication
      return 'none';
    }
  }
  return 'none';
}

// Test endpoint
app.get('/api/test', (req, res) => {
  res.json({ message: 'Server is running!', timestamp: new Date() });
});

// Get video info
app.post('/api/info', async (req, res) => {
  try {
    const { url, platform } = req.body;
    console.log('📥 Fetching info for:', url);
    console.log('📝 Platform:', platform);
    
    const args = [url, '--dump-json', '--no-warnings', '--skip-download'];
    
    const cookieMethod = addCookieArgs(args, platform);
    args.push('--extractor-retries', '3');
    
    try {
      const infoString = await ytDlp.execPromise(args);
      const info = JSON.parse(infoString);
      
      console.log('✅ Info fetched:', info.title);
      res.json(info);
    } catch (error) {
      // If it's a cookie error and we haven't tried without cookies yet
      if (error.message.includes('Could not copy') && cookieMethod !== 'none') {
        console.log('⚠️ Cookie database locked. Trying without cookies...');
        const fallbackArgs = [url, '--dump-json', '--no-warnings', '--skip-download', '--extractor-retries', '3'];
        
        try {
          const infoString = await ytDlp.execPromise(fallbackArgs);
          const info = JSON.parse(infoString);
          res.json(info);
        } catch (fallbackError) {
          throw new Error('Instagram requires authentication. Close Chrome completely or export cookies.txt');
        }
      } else {
        throw error;
      }
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    
    let suggestion = '';
    if (error.message.includes('Could not copy')) {
      suggestion = 'Close ALL Chrome windows and try again, or export cookies.txt file';
    } else if (error.message.includes('login required') || error.message.includes('rate-limit')) {
      suggestion = 'Instagram/TikTok requires authentication. Export cookies.txt file.';
    }
    
    res.status(500).json({ 
      error: error.message,
      suggestion: suggestion
    });
  }
});

// Progress tracking storage
const downloadProgress = new Map();

// SSE endpoint for progress updates
app.get('/api/download-progress/:id', (req, res) => {
  const { id } = req.params;
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  // Send initial progress
  const sendProgress = () => {
    const progress = downloadProgress.get(id) || { percent: 0, status: 'waiting' };
    res.write(`data: ${JSON.stringify(progress)}\n\n`);
  };
  
  sendProgress();
  
  // Update progress every 500ms
  const interval = setInterval(() => {
    const progress = downloadProgress.get(id);
    if (progress) {
      res.write(`data: ${JSON.stringify(progress)}\n\n`);
      
      if (progress.status === 'complete' || progress.status === 'error') {
        clearInterval(interval);
        setTimeout(() => {
          downloadProgress.delete(id);
          res.end();
        }, 1000);
      }
    }
  }, 500);
  
  req.on('close', () => {
    clearInterval(interval);
  });
});

// Download video
// Download video
// Download video with progress tracking
app.post('/api/download', async (req, res) => {
  let tempFilePath = null;
  let actualFilePath = null;
  const downloadId = Date.now().toString();
  
  // 1. Declare ytDlpProcess with 'let' outside any inner try block
  let ytDlpProcess; 

  try {
    const { url, formatId, platform } = req.body;
    console.log('📥 Downloading:', url);
    console.log('📝 Platform:', platform, '| Format:', formatId);
    
    // Send download ID to client
    res.json({ downloadId });
    
    // Initialize progress
    downloadProgress.set(downloadId, { percent: 0, status: 'analyzing' });
    
    // Get video info first (rest of info retrieval logic is skipped for brevity)
    // ... (info retrieval logic and argument building)
    let info;
    // ... (rest of info retrieval logic)
    
    const safeTitle = info.title.replace(/[^a-z0-9]/gi, '_').substring(0, 50);
    const timestamp = Date.now();
    
    let ext = info.ext || 'mp4';
    let contentType = 'video/mp4';
    // ... (rest of file type and path logic)
    
    tempFilePath = path.join(TEMP_DIR, `${timestamp}.%(ext)s`);
    
    console.log('📦 Target filename:', `${safeTitle}.${ext}`);
    
    // Update progress
    downloadProgress.set(downloadId, { percent: 10, status: 'downloading' });
    
    // Build download arguments
    const args = [url];
    addCookieArgs(args, platform);
    
    // Format selection
    // ... (rest of format selection logic)
    
    args.push('-o', tempFilePath);
    args.push('--no-warnings');
    args.push('--no-playlist');
    args.push('--newline'); // Important for progress parsing
    
    console.log('🚀 Downloading...');
    
    // ⭐ FIX 3: Dedicated try/catch for process creation ⭐
    try {
        // Execute download with progress tracking
        ytDlpProcess = ytDlp.exec(args);
    } catch (execError) {
        // If exec fails (e.g., yt-dlp path is wrong), throw it to the outer catch
        throw execError;
    }
    // ⭐ End dedicated try/catch for process creation ⭐


let lastProgress = 10;

// Better progress tracking
// THESE LINES NOW SAFELY USE ytDlpProcess
ytDlpProcess.stdout.on('data', (data) => {
  const output = data.toString();
  
  // Parse progress from yt-dlp output
  const progressMatch = output.match(/(\d+\.?\d*)%/);
  if (progressMatch) {
    const percent = Math.min(90, Math.round(parseFloat(progressMatch[1])));
    if (percent > lastProgress) {
      lastProgress = percent;
      downloadProgress.set(downloadId, { 
        percent, 
        status: 'downloading'
      });
      console.log(`📊 Progress: ${percent}%`);
    }
  }
});

ytDlpProcess.on('close', async (code) => {
  console.log('📦 yt-dlp process closed with code:', code);
  
  try {
    if (code !== 0) {
      throw new Error(`Download failed with exit code ${code}`);
    }
    
    downloadProgress.set(downloadId, { percent: 95, status: 'processing' });
    
    // Wait a bit for file system to sync
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Find the downloaded file
    const files = fs.readdirSync(TEMP_DIR).filter(f => 
      f.startsWith(timestamp.toString()) && !f.endsWith('.path') && !f.endsWith('.part')
    );
    
    if (files.length === 0) {
      console.error('❌ No files found. Files in temp:', fs.readdirSync(TEMP_DIR));
      throw new Error('Download failed - no file created');
    }
    
    actualFilePath = path.join(TEMP_DIR, files[0]);
    
    // Verify file exists and has content
    if (!fs.existsSync(actualFilePath)) {
      throw new Error('Downloaded file not found');
    }
    
    const stats = fs.statSync(actualFilePath);
    if (stats.size === 0) {
      throw new Error('Downloaded file is empty');
    }
    
    const actualExt = path.extname(files[0]).substring(1) || ext;
    
    console.log('✅ Downloaded to:', actualFilePath);
    console.log('📊 File size:', (stats.size / 1024 / 1024).toFixed(2), 'MB');
    
    // Update content type
    if (actualExt === 'mp3' || actualExt === 'm4a') {
      contentType = 'audio/mpeg';
    } else if (actualExt === 'mp4') {
      contentType = 'video/mp4';
    } else if (actualExt === 'webm') {
      contentType = 'video/webm';
    } else if (['jpg', 'jpeg'].includes(actualExt)) {
      contentType = 'image/jpeg';
    } else if (actualExt === 'png') {
      contentType = 'image/png';
    }
    
    const downloadFilename = `${safeTitle}.${actualExt}`;
    
    // Store file info for retrieval
    downloadProgress.set(downloadId, { 
      percent: 100, 
      status: 'complete',
      filePath: actualFilePath,
      filename: downloadFilename,
      contentType: contentType,
      fileSize: stats.size
    });
    
    console.log('✅ Download complete and ready:', downloadFilename);
    
  } catch (error) {
    console.error('❌ Error in close handler:', error);
    downloadProgress.set(downloadId, { 
      percent: 0, 
      status: 'error',
      error: error.message 
    });
  }
});

ytDlpProcess.on('error', (error) => {
  console.error('❌ Process error:', error);
  downloadProgress.set(downloadId, { 
    percent: 0, 
    status: 'error',
    error: error.message 
  });
});

ytDlpProcess.stderr.on('data', (data) => {
  console.error('⚠️ yt-dlp stderr:', data.toString());
});

} catch (error) { // <-- FIX 2: This is the main route handler's catch block
    console.error('❌ Outer Download Route Handler Error:', error.message);
    downloadProgress.set(downloadId, {
        percent: 0,
        status: 'error',
        error: error.message || 'Unknown download error occurred'
    });
}
});
// ... (rest of the file remains the same)
// Get downloaded file
app.get('/api/download-file/:id', async (req, res) => {
  const { id } = req.params;
  const progress = downloadProgress.get(id);
  
  if (!progress || progress.status !== 'complete') {
    return res.status(404).json({ error: 'File not ready or not found' });
  }
  
  const { filePath, filename, contentType, fileSize } = progress;
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': fileSize,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  });
  
  const fileStream = fs.createReadStream(filePath);
  fileStream.pipe(res);
  
  res.on('finish', async () => {
    try {
      await unlinkAsync(filePath);
      downloadProgress.delete(id);
      console.log('🗑️ Temp file cleaned up');
    } catch (err) {
      console.log('⚠️ Could not delete temp file');
    }
  });
});

// Debug endpoint to check download status
app.get('/api/debug-download/:id', (req, res) => {
  const { id } = req.params;
  const progress = downloadProgress.get(id);
  
  if (!progress) {
    return res.json({ 
      found: false, 
      message: 'Download ID not found',
      allIds: Array.from(downloadProgress.keys())
    });
  }
  
  const fileExists = progress.filePath ? fs.existsSync(progress.filePath) : false;
  const fileSize = fileExists ? fs.statSync(progress.filePath).size : 0;
  
  res.json({
    found: true,
    progress: progress,
    fileExists: fileExists,
    fileSize: fileSize,
    tempDir: TEMP_DIR,
    filesInTemp: fs.readdirSync(TEMP_DIR)
  });
});    


const PORT = 3001;
app.listen(PORT, () => {
  console.log('✅ Server running on http://localhost:' + PORT);
  console.log('📁 Temp directory:', TEMP_DIR);
  console.log('');
  console.log('💡 Tips:');
  console.log('   - YouTube: Works perfectly ✓');
  console.log('   - Pinterest: Works ✓');
  console.log('   - Instagram/TikTok: Needs cookies.txt or Chrome closed');
  console.log('');
  console.log('🍪 To fix Instagram:');
  console.log('   1. Install: https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc');
  console.log('   2. Login to Instagram in Chrome');
  console.log('   3. Export cookies.txt to:', __dirname);
  console.log('   4. Restart this server');
})
