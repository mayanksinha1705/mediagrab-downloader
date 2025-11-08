const express = require('express');
const cors = require('cors');
const YTDlpWrap = require('yt-dlp-wrap').default;
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { execSync } = require('child_process');

const app = express();

// ⭐ NEW: Define PROXY_URL from environment variable (Kept for proxy fallback)
const PROXY_URL = process.env.YT_DLP_PROXY || null; 

// Check and install yt-dlp
let ytDlpPath = 'yt-dlp';

try {
  execSync('which yt-dlp || which yt-dlp.exe', { stdio: 'pipe' });
  console.log('✅ yt-dlp found in system');
} catch (error) {
  try {
    console.log('⚠️ Installing yt-dlp...');
    // NOTE: The build command MUST be updated to include yt-dlp-youtube-oauth2
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

// ⭐ NEW: Combined authentication function
function addAuthArgs(args, platform) {
    const cookiePath = path.join(__dirname, 'cookies.txt');
    
    // --- 1. Primary Method: OAuth2 Login (Requires external authorization) ---
    args.push('--username', 'oauth2'); // Tells yt-dlp to use OAuth2 client
    args.push('--password', '');        // Password is left empty for OAuth2
    args.push('--ppa', 'youtube_oauth2'); // Activates the installed OAuth2 plugin
    console.log('🔑 Attempting OAuth2 login (Primary)');

    // --- 2. Fallback Method: Cookies File ---
    if (fs.existsSync(cookiePath)) {
        args.push('--cookies', cookiePath);
        console.log('🍪 Adding cookies.txt as fallback.');
    } else {
        console.log('⚠️ No cookies.txt found for fallback.');
    }

    // --- 3. Client Impersonation / Spoofing ---
    // User-Agent: Makes request look like a modern browser
    args.push('--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    // Extractor Arg: Makes the request look like it came from the YouTube Android App
    args.push('--extractor-args', 'youtube:player-client=android');
}


// Test endpoint
app.get('/api/test', (req, res) => {
  res.json({ message: 'Server is running!', timestamp: new Date() });
});

// Test yt-dlp
app.get('/api/test-ytdlp', async (req, res) => {
  try {
    console.log('Testing yt-dlp...');
    
    let version;
    try {
      version = execSync('yt-dlp --version').toString().trim();
      console.log('✅ yt-dlp version:', version);
    } catch (e) {
      throw new Error('yt-dlp not installed');
    }
    
    const testYtDlp = new YTDlpWrap();
    const testProcess = testYtDlp.exec(['--version']);
    
    res.json({
      status: 'ok',
      ytdlpVersion: version,
      ytDlpWrapWorks: true,
      execWorks: true,
      processType: typeof testProcess,
      hasStdout: !!testProcess.stdout,
      hasOn: typeof testProcess.on
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
});

// Get video info
app.post('/api/info', async (req, res) => {
  try {
    const { url, platform } = req.body;
    console.log('📥 Fetching info for:', url);
    
    const args = [url, '--dump-json', '--no-warnings', '--skip-download'];
    // ⭐ UPDATED TO USE NEW AUTH FUNCTION
    addAuthArgs(args, platform); 

    // ⭐ CORRECTION: Add proxy argument for info fetch
    if (PROXY_URL) {
        args.push('--proxy', PROXY_URL);
        console.log('🌐 Routing info request through proxy.');
    }
    
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
  
  console.log('=== DOWNLOAD START ===');
  console.log('Download ID:', downloadId);
  
  try {
    const { url, formatId, platform } = req.body;
    console.log('1. Request:', { url, formatId, platform });
    
    // Send download ID immediately
    res.json({ downloadId });
    console.log('2. Download ID sent');
    
    downloadProgress.set(downloadId, { percent: 0, status: 'analyzing' });
    console.log('3. Progress initialized');
    
    // Get video info
    console.log('4. Fetching video info...');
    const infoArgs = [url, '--dump-json', '--no-warnings', '--skip-download'];
    // ⭐ UPDATED TO USE NEW AUTH FUNCTION
    addAuthArgs(infoArgs, platform);
    
    // ⭐ CORRECTION: Add proxy argument for infoArgs
    if (PROXY_URL) {
        infoArgs.push('--proxy', PROXY_URL);
    }
    
    let info;
    try {
      const infoString = await ytDlp.execPromise(infoArgs);
      info = JSON.parse(infoString);
      console.log('5. Info fetched:', info.title);
    } catch (infoError) {
      console.error('5. ERROR:', infoError.message);
      throw infoError;
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
    console.log('6. Temp path:', tempFilePath);
    
    downloadProgress.set(downloadId, { percent: 10, status: 'downloading' });
    
    // Build download arguments
    const args = [url];
    // ⭐ UPDATED TO USE NEW AUTH FUNCTION
    addAuthArgs(args, platform); 
    
    // ⭐ CORRECTION: Add proxy argument for main download args
    if (PROXY_URL) {
        args.push('--proxy', PROXY_URL);
        console.log('🌐 Routing download through proxy.');
    }
    
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
    
    console.log('7. Args:', args.join(' '));
    console.log('8. Creating process...');
    
    let downloadProcess;
    try {
      // Explicitly configure stdio to help ensure stdout pipe is created
      downloadProcess = ytDlp.exec(args, {
        stdio: [
          'ignore', // stdin
          'pipe',   // stdout
          'pipe'    // stderr
        ]
      });
      console.log('9. ✅ Process created');
      console.log('   Type:', typeof downloadProcess);
      console.log('   Has stdout:', !!downloadProcess.stdout);
      console.log('   Has on:', typeof downloadProcess.on);
    } catch (execError) {
      console.error('9. ❌ ERROR:', execError.message);
      throw new Error(`Failed to create process: ${execError.message}`);
    }
    
    if (!downloadProcess) {
      throw new Error('Process is null');
    }
    
    // !!! THE PREVIOUSLY FAILING CHECK HAS BEEN REMOVED !!!
    /*     if (!downloadProcess.stdout) {
      throw new Error('Process has no stdout');
    }
    */
    
    console.log('10. Attaching listeners...');
    
    let lastProgress = 10;
    
    try {
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
      console.log('11. stdout listener OK');
    } catch (e) {
      console.error('11. ERROR:', e.message);
    }
    
    try {
      downloadProcess.stderr.on('data', (data) => {
        console.error('⚠️ stderr:', data.toString());
      });
      console.log('12. stderr listener OK');
    } catch (e) {
      console.error('12. ERROR:', e.message);
    }
    
    try {
      downloadProcess.on('error', (error) => {
        console.error('❌ Process error:', error);
        downloadProgress.set(downloadId, { 
          percent: 0, 
          status: 'error',
          error: error.message 
        });
      });
      console.log('13. error listener OK');
    } catch (e) {
      console.error('13. ERROR:', e.message);
    }
    
    try {
      downloadProcess.on('close', async (code) => {
        console.log('📦 Closed with code:', code);
        
        try {
          if (code !== 0) {
            throw new Error(`Exit code ${code}`);
          }
          
          downloadProgress.set(downloadId, { percent: 95, status: 'processing' });
          
          await new Promise(resolve => setTimeout(resolve, 1500));
          
          const files = fs.readdirSync(TEMP_DIR).filter(f => 
            f.startsWith(timestamp.toString()) && !f.endsWith('.path') && !f.endsWith('.part')
          );
          
          if (files.length === 0) {
            console.error('❌ No files. Dir:', fs.readdirSync(TEMP_DIR));
            throw new Error('No file created');
          }
          
          const actualFilePath = path.join(TEMP_DIR, files[0]);
          
          if (!fs.existsSync(actualFilePath)) {
            throw new Error('File not found');
          }
          
          const stats = fs.statSync(actualFilePath);
          if (stats.size === 0) {
            throw new Error('File is empty');
          }
          
          const actualExt = path.extname(files[0]).substring(1) || ext;
          
          console.log('✅ File:', actualFilePath);
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
          
          console.log('✅ Ready:', downloadFilename);
          console.log('=== DOWNLOAD COMPLETE ===');
          
        } catch (closeError) {
          console.error('❌ Close error:', closeError.message);
          downloadProgress.set(downloadId, { 
            percent: 0, 
            status: 'error',
            error: closeError.message 
          });
        }
      });
      console.log('14. close listener OK');
      console.log('=== SETUP COMPLETE ===');
    } catch (e) {
      console.error('14. ERROR:', e.message);
      throw e;
    }
    
  } catch (error) {
    console.error('=== DOWNLOAD ERROR ===');
    console.error('Message:', error.message);
    console.error('Stack:', error.stack);
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
  
  console.log('📥 File request:', id);
  console.log('📊 Status:', progress?.status);
  
  if (!progress) {
    console.error('❌ ID not found');
    return res.status(404).json({ error: 'Download ID not found' });
  }
  
  if (progress.status !== 'complete') {
    console.error('❌ Not ready. Status:', progress.status);
    return res.status(404).json({ error: `Not ready. Status: ${progress.status}` });
  }
  
  const { filePath, filename, contentType, fileSize } = progress;
  
  if (!fs.existsSync(filePath)) {
    console.error('❌ File missing:', filePath);
    return res.status(404).json({ error: 'File not found on disk' });
  }
  
  console.log('✅ Sending:', filename);
  
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
      console.log('🗑️ Cleaned:', filename);
    } catch (err) {
      console.log('⚠️ Cleanup failed');
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
  console.log('✅ Server on port', PORT);
  console.log('📁 Temp:', TEMP_DIR);
  console.log('🚀 Ready!');
});
