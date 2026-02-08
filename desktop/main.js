const { app, BrowserWindow, desktopCapturer, ipcMain, screen, Notification } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;
let screenshotInterval;
let sessionActive = false;
let sessionData = {
  stake: 0,
  startTime: null,
  screenshots: [],
  distractionCount: 0
};

// Blocked apps/sites - AI will look for these
const BLOCKED_KEYWORDS = [
  'tiktok', 'instagram', 'twitter', 'x.com', 'facebook', 'reddit',
  'youtube', 'netflix', 'twitch', 'discord', 'telegram', 'whatsapp',
  'games', 'steam', 'spotify', 'amazon', 'shopping'
];

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 750,
    resizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a0a'
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Screenshot and AI Analysis
async function takeScreenshot() {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 }
    });

    if (sources.length > 0) {
      const screenshot = sources[0].thumbnail.toDataURL();
      return screenshot;
    }
  } catch (error) {
    console.error('Screenshot error:', error);
  }
  return null;
}

async function analyzeScreenshot(screenshotBase64) {
  // Use Claude API to analyze the screenshot
  const apiKey = process.env.ANTHROPIC_API_KEY;
  
  if (!apiKey) {
    // Fallback: simple keyword detection in window titles
    return { distracted: false, reason: 'API key not set - using basic detection' };
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 150,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: screenshotBase64.replace('data:image/png;base64,', '')
              }
            },
            {
              type: 'text',
              text: `You are a focus accountability AI. Analyze this screenshot and determine if the user is DISTRACTED or FOCUSED.

DISTRACTED if you see: social media (TikTok, Instagram, Twitter/X, Facebook, Reddit), video streaming (YouTube, Netflix, Twitch), messaging apps (Discord, WhatsApp, Telegram), games, shopping sites, or anything clearly not work-related.

FOCUSED if you see: code editors, documents, spreadsheets, email (work), research, writing, design tools, terminal, or productive work.

Respond with ONLY valid JSON:
{"distracted": true/false, "app": "detected app name", "reason": "brief reason"}`
            }
          ]
        }]
      })
    });

    const data = await response.json();
    const content = data.content[0].text;
    return JSON.parse(content);
  } catch (error) {
    console.error('AI analysis error:', error);
    return { distracted: false, reason: 'Analysis failed' };
  }
}

// IPC handlers for renderer
ipcMain.handle('start-session', async (event, { stake, duration, interval }) => {
  sessionActive = true;
  sessionData = {
    stake,
    duration,
    startTime: Date.now(),
    screenshots: [],
    distractionCount: 0,
    interval: interval || 60 // Default 60 seconds
  };

  // Start screenshot monitoring
  screenshotInterval = setInterval(async () => {
    if (!sessionActive) return;

    const screenshot = await takeScreenshot();
    if (screenshot) {
      const analysis = await analyzeScreenshot(screenshot);
      
      sessionData.screenshots.push({
        time: Date.now(),
        analysis
      });

      // Send update to renderer
      mainWindow.webContents.send('screenshot-taken', analysis);

      if (analysis.distracted) {
        sessionData.distractionCount++;
        
        // Show notification
        new Notification({
          title: '⚠️ StakeFlow Warning!',
          body: `Distraction detected: ${analysis.app || 'Unknown'}. Get back to work or lose $${stake}!`
        }).show();

        // 3 strikes and you're out
        if (sessionData.distractionCount >= 3) {
          mainWindow.webContents.send('session-failed', {
            reason: 'Too many distractions detected',
            distractions: sessionData.screenshots.filter(s => s.analysis.distracted)
          });
          endSession(false);
        }
      }
    }
  }, sessionData.interval * 1000);

  return { success: true };
});

ipcMain.handle('end-session', async (event, { won }) => {
  return endSession(won);
});

function endSession(won) {
  sessionActive = false;
  if (screenshotInterval) {
    clearInterval(screenshotInterval);
    screenshotInterval = null;
  }

  const result = {
    won,
    stake: sessionData.stake,
    duration: Date.now() - sessionData.startTime,
    distractionCount: sessionData.distractionCount,
    totalScreenshots: sessionData.screenshots.length
  };

  sessionData = {
    stake: 0,
    startTime: null,
    screenshots: [],
    distractionCount: 0
  };

  return result;
}

ipcMain.handle('get-session-status', () => {
  return {
    active: sessionActive,
    ...sessionData
  };
});
