const express = require('express');
const cors = require('cors');
const YTDlpWrap = require('yt-dlp-wrap').default;
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

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
// Download video with progress tracking
app.post('/api/download', async (req, res) => {
  let tempFilePath = null;
  let actualFilePath = null;
  const downloadId = Date.now().toString();
  
  try {
    const { url, formatId, platform } = req.body;
    console.log('📥 Downloading:', url);
    console.log('📝 Platform:', platform, '| Format:', formatId);
    
    // Send download ID to client
    res.json({ downloadId });
    
    // Initialize progress
    downloadProgress.set(downloadId, { percent: 0, status: 'analyzing' });
    
    // Get video info first
    const infoArgs = [url, '--dump-json', '--no-warnings', '--skip-download'];
    addCookieArgs(infoArgs, platform);
    
    let info;
    try {
      const infoString = await ytDlp.execPromise(infoArgs);
      info = JSON.parse(infoString);
    } catch (error) {
      if (error.message.includes('Could not copy')) {
        const fallbackArgs = [url, '--dump-json', '--no-warnings', '--skip-download'];
        const infoString = await ytDlp.execPromise(fallbackArgs);
        info = JSON.parse(infoString);
      } else {
        throw error;
      }
    }
    
    const safeTitle = info.title.replace(/[^a-z0-9]/gi, '_').substring(0, 50);
    const timestamp = Date.now();
    
    let ext = info.ext || 'mp4';
    let contentType = 'video/mp4';
    
    if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext.toLowerCase())) {
      contentType = ext.toLowerCase() === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    } else if (ext === 'mp3' || ext === 'm4a') {
      contentType = 'audio/mpeg';
      ext = 'mp3';
    } else {
      ext = 'mp4';
      contentType = 'video/mp4';
    }
    
    tempFilePath = path.join(TEMP_DIR, `${timestamp}.%(ext)s`);
    
    console.log('📦 Target filename:', `${safeTitle}.${ext}`);
    
    // Update progress
    downloadProgress.set(downloadId, { percent: 10, status: 'downloading' });
    
    // Build download arguments
    const args = [url];
    addCookieArgs(args, platform);
    
    // Format selection
    if (contentType.startsWith('video/')) {
      if (formatId === 'audio') {
        args.push('-f', 'bestaudio/best');
        args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
        ext = 'mp3';
        contentType = 'audio/mpeg';
      } else if (formatId === '1080p') {
        args.push('-f', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best');
      } else if (formatId === '720p') {
        args.push('-f', 'bestvideo[height<=720]+bestaudio/best[height<=720]/best');
      } else if (formatId === '480p') {
        args.push('-f', 'bestvideo[height<=480]+bestaudio/best[height<=480]/best');
      } else {
        args.push('-f', 'bestvideo+bestaudio/best');
      }
      
      if (formatId !== 'audio') {
        args.push('--merge-output-format', 'mp4');
      }
    }
    
    args.push('-o', tempFilePath);
    args.push('--no-warnings');
    args.push('--no-playlist');
    args.push('--newline'); // Important for progress parsing
    
    console.log('🚀 Downloading...');
    
    // Execute download with progress tracking
    const ytDlpProcess = ytDlp.exec(args);
    
    ytDlpProcess.on('progress', (progressInfo) => {
      if (progressInfo.percent) {
        const percent = Math.min(90, Math.round(progressInfo.percent));
        downloadProgress.set(downloadId, { 
          percent, 
          status: 'downloading',
          speed: progressInfo.speed,
          eta: progressInfo.eta
        });
        console.log(`📊 Progress: ${percent}%`);
      }
    });
    
    ytDlpProcess.on('close', async () => {
      try {
        downloadProgress.set(downloadId, { percent: 95, status: 'processing' });
        
        // Find the downloaded file
        const files = fs.readdirSync(TEMP_DIR).filter(f => 
          f.startsWith(timestamp.toString()) && !f.endsWith('.path')
        );
        
        if (files.length === 0) {
          throw new Error('Download failed - no file created');
        }
        
        actualFilePath = path.join(TEMP_DIR, files[0]);
        const actualExt = path.extname(files[0]).substring(1) || ext;
        
        console.log('✅ Downloaded to:', actualFilePath);
        
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
        
        const stats = fs.statSync(actualFilePath);
        const fileSize = stats.size;
        
        console.log(`📊 File size: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);
        
        const downloadFilename = `${safeTitle}.${actualExt}`;
        
        // Store file info for retrieval
        downloadProgress.set(downloadId, { 
          percent: 100, 
          status: 'complete',
          filePath: actualFilePath,
          filename: downloadFilename,
          contentType: contentType,
          fileSize: fileSize
        });
        
      } catch (error) {
        console.error('❌ Error:', error);
        downloadProgress.set(downloadId, { 
          percent: 0, 
          status: 'error',
          error: error.message 
        });
      }
    });
    
    ytDlpProcess.on('error', (error) => {
      console.error('❌ Download error:', error);
      downloadProgress.set(downloadId, { 
        percent: 0, 
        status: 'error',
        error: error.message 
      });
    });
    
  } catch (error) {
    console.error('❌ Download error:', error.message);
    downloadProgress.set(downloadId, { 
      percent: 0, 
      status: 'error',
      error: error.message 
    });
  }
});

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


const PORT = 3001;
app.listen(PORT, () => {
  console.log('✅ Server running on http://localhost:' + PORT);
  console.log('📁 Temp directory:', TEMP_DIR);
  console.log('');
  console.log('💡 Tips:');
  console.log('   - YouTube: Works perfectly ✓');
  console.log('   - Pinterest: Works ✓');
  console.log('   - Instagram/TikTok: Needs cookies.txt or Chrome closed');
  console.log('');
  console.log('🍪 To fix Instagram:');
  console.log('   1. Install: https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc');
  console.log('   2. Login to Instagram in Chrome');
  console.log('   3. Export cookies.txt to:', __dirname);
  console.log('   4. Restart this server');
})