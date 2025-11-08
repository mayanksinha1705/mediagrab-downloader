const express = require('express');
const cors = require('cors');
const YTDlpWrap = require('yt-dlp-wrap').default;
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { execSync } = require('child_process');

const app = express();

// Check and install yt-dlp
let ytDlpPath = 'yt-dlp';

try {
  execSync('which yt-dlp || which yt-dlp.exe', { stdio: 'pipe' });
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

const ytDlp = new YTDlpWrap(ytDlpPath);

app.use(cors());
app.use(express.json());

const unlinkAsync = promisify(fs.unlink);
const downloadProgress = new Map();

// Create temp directory
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR);
  console.log('📁 Created temp directory:', TEMP_DIR);
}

// Clean old temp files
function cleanTempFiles() {
  fs.readdir(TEMP_DIR, (err, files) => {
    if (err) return;
    files.forEach(file => {
      const filePath = path.join(TEMP_DIR, file);
      try {
        const stats = fs.statSync(filePath);
        const now = Date.now();
        const fileAge = now - stats.mtimeMs;
        if (fileAge > 3600000) {
          fs.unlink(filePath, () => {});
        }
      } catch (e) {}
    });
  });
}

cleanTempFiles();
setInterval(cleanTempFiles, 1800000);

// Helper function to add cookie arguments
function addCookieArgs(args, platform) {
  const cookiePath = path.join(__dirname, 'cookies.txt');
  
  if (fs.existsSync(cookiePath)) {
    args.push('--cookies', cookiePath);
    console.log('🍪 Using cookies.txt file for', platform);
    return 'file';
  } else {
    console.log('⚠️ No cookies.txt found');
    return 'none';
  }
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
    
    const args = [url, '--dump-json', '--no-warnings', '--skip-download'];
    addCookieArgs(args, platform);
    args.push('--extractor-retries', '3');
    
    const infoString = await ytDlp.execPromise(args);
    const info = JSON.parse(infoString);
    
    console.log('✅ Info fetched:', info.title);
    res.json(info);
  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({ 
      error: error.message,
      suggestion: 'Try a different URL or check if the video is available'
    });
  }
});

// SSE endpoint for progress updates
app.get('/api/download-progress/:id', (req, res) => {
  const { id } = req.params;
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const sendProgress = () => {
    const progress = downloadProgress.get(id) || { percent: 0, status: 'waiting' };
    res.write(`data: ${JSON.stringify(progress)}\n\n`);
  };
  
  sendProgress();
  
  const interval = setInterval(() => {
    const progress = downloadProgress.get(id);
    if (progress) {
      res.write(`data: ${JSON.stringify(progress)}\n\n`);
      
      if (progress.status === 'complete' || progress.status === 'error') {
        clearInterval(interval);
        setTimeout(() => res.end(), 1000);
      }
    }
  }, 500);
  
  req.on('close', () => clearInterval(interval));
});

// Download video with progress tracking
app.post('/api/download', async (req, res) => {
  const downloadId = Date.now().toString();
  let tempFilePath = null;
  
  try {
    const { url, formatId, platform } = req.body;
    console.log('📥 Starting download:', url);
    
    // Send download ID immediately
    res.json({ downloadId });
    
    downloadProgress.set(downloadId, { percent: 0, status: 'analyzing' });
    
    // Get video info
    const infoArgs = [url, '--dump-json', '--no-warnings', '--skip-download'];
    addCookieArgs(infoArgs, platform);
    
    const infoString = await ytDlp.execPromise(infoArgs);
    const info = JSON.parse(infoString);
    
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
    
    downloadProgress.set(downloadId, { percent: 10, status: 'downloading' });
    
    // Build download arguments
    const args = [url];
    addCookieArgs(args, platform);
    
    if (contentType.startsWith('video/')) {
      if (formatId === 'audio') {
        args.push('-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '0');
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
    
    args.push('-o', tempFilePath, '--no-warnings', '--no-playlist', '--newline');
    
    console.log('🚀 Executing download...');
    
    // Use execPromise instead of exec for better error handling
    const downloadProcess = ytDlp.exec(args);
    
    let lastProgress = 10;
    
    downloadProcess.stdout.on('data', (data) => {
      const output = data.toString();
      const progressMatch = output.match(/(\d+\.?\d*)%/);
      if (progressMatch) {
        const percent = Math.min(90, Math.round(parseFloat(progressMatch[1])));
        if (percent > lastProgress) {
          lastProgress = percent;
          downloadProgress.set(downloadId, { percent, status: 'downloading' });
          console.log(`📊 Progress: ${percent}%`);
        }
      }
    });
    
    downloadProcess.stderr.on('data', (data) => {
      console.error('⚠️ yt-dlp stderr:', data.toString());
    });
    
    downloadProcess.on('error', (error) => {
      console.error('❌ Process error:', error);
      downloadProgress.set(downloadId, { 
        percent: 0, 
        status: 'error',
        error: error.message 
      });
    });
    
    downloadProcess.on('close', async (code) => {
      console.log('📦 Process closed with code:', code);
      
      try {
        if (code !== 0) {
          throw new Error(`Download failed with exit code ${code}`);
        }
        
        downloadProgress.set(downloadId, { percent: 95, status: 'processing' });
        
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const files = fs.readdirSync(TEMP_DIR).filter(f => 
          f.startsWith(timestamp.toString()) && !f.endsWith('.path') && !f.endsWith('.part')
        );
        
        if (files.length === 0) {
          console.error('❌ No files found. Files in temp:', fs.readdirSync(TEMP_DIR));
          throw new Error('Download failed - no file created');
        }
        
        const actualFilePath = path.join(TEMP_DIR, files[0]);
        
        if (!fs.existsSync(actualFilePath)) {
          throw new Error('Downloaded file not found');
        }
        
        const stats = fs.statSync(actualFilePath);
        if (stats.size === 0) {
          throw new Error('Downloaded file is empty');
        }
        
        const actualExt = path.extname(files[0]).substring(1) || ext;
        
        console.log('✅ Downloaded:', actualFilePath);
        console.log('📊 Size:', (stats.size / 1024 / 1024).toFixed(2), 'MB');
        
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
        
        downloadProgress.set(downloadId, { 
          percent: 100, 
          status: 'complete',
          filePath: actualFilePath,
          filename: downloadFilename,
          contentType: contentType,
          fileSize: stats.size
        });
        
        console.log('✅ Ready for download:', downloadFilename);
        
      } catch (error) {
        console.error('❌ Close handler error:', error);
        downloadProgress.set(downloadId, { 
          percent: 0, 
          status: 'error',
          error: error.message 
        });
      }
    });
    
  } catch (error) {
    console.error('❌ Download route error:', error.message);
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
  
  console.log('📥 File request for ID:', id);
  console.log('📊 Progress:', progress);
  
  if (!progress) {
    console.error('❌ Download ID not found');
    return res.status(404).json({ error: 'Download ID not found' });
  }
  
  if (progress.status !== 'complete') {
    console.error('❌ File not ready. Status:', progress.status);
    return res.status(404).json({ error: `File not ready. Status: ${progress.status}` });
  }
  
  const { filePath, filename, contentType, fileSize } = progress;
  
  if (!fs.existsSync(filePath)) {
    console.error('❌ File does not exist:', filePath);
    return res.status(404).json({ error: 'File not found on disk' });
  }
  
  console.log('✅ Sending file:', filename);
  
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
      console.log('🗑️ Cleaned up:', filename);
    } catch (err) {
      console.log('⚠️ Cleanup failed:', err.message);
    }
  });
});

// Debug endpoint
app.get('/api/debug-download/:id', (req, res) => {
  const { id } = req.params;
  const progress = downloadProgress.get(id);
  
  if (!progress) {
    return res.json({ 
      found: false, 
      allIds: Array.from(downloadProgress.keys()),
      totalDownloads: downloadProgress.size
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log('✅ Server running on port', PORT);
  console.log('📁 Temp directory:', TEMP_DIR);
  console.log('🚀 Ready to download!');
});
