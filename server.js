// ═══════════════════════════════════════════════════════════════
//  SnapLoad Backend — Download & Convert Server
//  Runs locally OR deployed on Railway/Render via Docker
// ═══════════════════════════════════════════════════════════════

import express  from 'express'
import cors     from 'cors'
import fs       from 'fs'
import path     from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import { fileURLToPath } from 'url'
import multer   from 'multer'
import { v4 as uuidv4 } from 'uuid'

const execAsync = promisify(exec)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── Config ─────────────────────────────────────────────────────
const PORT    = process.env.PORT || 4000
const TMP_DIR = process.env.TMP_DIR || path.join(__dirname, 'tmp')

// CORS: allow your Cloudflare Pages domain + localhost dev
const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:4173',
  // Add your Cloudflare Pages domain:
  process.env.FRONTEND_URL,       // e.g. https://snapload.pages.dev
  process.env.FRONTEND_URL_CUSTOM, // e.g. https://snapload.app
].filter(Boolean)

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true })

// ── App ─────────────────────────────────────────────────────────
const app = express()

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (curl, mobile apps)
    // OR from allowed origins
    if (!origin || ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.length === 0) {
      cb(null, true)
    } else {
      cb(new Error(`CORS blocked: ${origin}`))
    }
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}))

app.use(express.json({ limit: '10mb' }))

// Serve tmp files
app.use('/tmp', express.static(TMP_DIR))

// File upload (for convert)
const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
})

// ── Tool detection ──────────────────────────────────────────────
let _ytDlp = null
let _ffmpeg = null

async function getYtDlp() {
  if (_ytDlp) return _ytDlp
  for (const cmd of ['yt-dlp', '/usr/local/bin/yt-dlp', 'python3 -m yt_dlp']) {
    try { await execAsync(`${cmd} --version`, { timeout: 5000 }); _ytDlp = cmd; return cmd }
    catch { /* try next */ }
  }
  throw new Error('yt-dlp not found. Install: winget install yt-dlp (Windows) or apt install yt-dlp (Linux)')
}

async function getFfmpeg() {
  if (_ffmpeg) return _ffmpeg
  for (const cmd of ['ffmpeg', '/usr/bin/ffmpeg']) {
    try { await execAsync(`${cmd} -version`, { timeout: 5000 }); _ffmpeg = cmd; return cmd }
    catch { /* try next */ }
  }
  throw new Error('ffmpeg not found. Install: winget install ffmpeg (Windows) or apt install ffmpeg (Linux)')
}

// ── Helpers ─────────────────────────────────────────────────────
function detectPlatform(url) {
  const map = [
    ['youtu', 'YouTube'], ['tiktok', 'TikTok'], ['instagram', 'Instagram'],
    ['facebook', 'Facebook'], ['twitter', 'Twitter/X'], ['x.com', 'Twitter/X'],
    ['reddit', 'Reddit'], ['vimeo', 'Vimeo'],
  ]
  for (const [k, n] of map) if (url.includes(k)) return n
  return 'Web'
}

function cleanTmp() {
  try {
    const MAX_AGE = 30 * 60 * 1000
    const now = Date.now()
    fs.readdirSync(TMP_DIR).forEach(f => {
      const full = path.join(TMP_DIR, f)
      try {
        if (now - fs.statSync(full).mtimeMs > MAX_AGE) fs.unlinkSync(full)
      } catch { /* ignore */ }
    })
  } catch { /* ignore */ }
}
setInterval(cleanTmp, 10 * 60 * 1000)

function deleteFiles(...paths) {
  paths.forEach(p => { try { if (p && fs.existsSync(p)) fs.unlinkSync(p) } catch { /* ignore */ } })
}

// ── ROUTES ──────────────────────────────────────────────────────

// Health check
app.get('/api/health', async (req, res) => {
  let ytdlp = false, ffmpegOk = false
  try { await getYtDlp(); ytdlp = true } catch { /* offline */ }
  try { await getFfmpeg(); ffmpegOk = true } catch { /* offline */ }
  res.json({
    ok: true,
    server: 'SnapLoad Backend',
    version: '1.0.0',
    tools: { ytdlp, ffmpeg: ffmpegOk },
    port: PORT,
  })
})

// ── POST /api/info — fetch video metadata ───────────────────────
app.post('/api/info', async (req, res) => {
  const { url, format } = req.body
  if (!url) return res.status(400).json({ error: 'URL is required' })

  try {
    const ytDlp = await getYtDlp()
    const { stdout } = await execAsync(
      `${ytDlp} --dump-json --no-playlist --no-warnings --no-check-certificate "${url}"`,
      { timeout: 30000 }
    )

    const info     = JSON.parse(stdout.trim().split('\n')[0])
    const platform = detectPlatform(url)
    const title    = info.title || 'Video'
    const thumb    = info.thumbnail || ''
    const duration = info.duration
      ? `${Math.floor(info.duration / 60)}:${String(info.duration % 60).padStart(2, '0')}`
      : ''

    // Build format options
    const BASE = `${req.protocol}://${req.get('host')}`
    const enc  = encodeURIComponent(url)
    let formats = []

    if (format === 'mp3' || format === 'convert') {
      formats = [
        { format:'mp3', quality:'320 kbps', value:'320', size:'~8.5 MB/min', downloadUrl:`${BASE}/api/download?url=${enc}&format=mp3&quality=320` },
        { format:'mp3', quality:'256 kbps', value:'256', size:'~6.8 MB/min', downloadUrl:`${BASE}/api/download?url=${enc}&format=mp3&quality=256` },
        { format:'mp3', quality:'192 kbps', value:'192', size:'~5.1 MB/min', downloadUrl:`${BASE}/api/download?url=${enc}&format=mp3&quality=192` },
        { format:'mp3', quality:'128 kbps', value:'128', size:'~3.4 MB/min', downloadUrl:`${BASE}/api/download?url=${enc}&format=mp3&quality=128` },
      ]
    } else {
      // Detect max available resolution
      const heights = new Set()
      ;(info.formats || []).forEach(f => { if (f.height) heights.add(f.height) })
      const maxH = heights.size > 0 ? Math.max(...heights) : 1080

      const resOpts = [
        { label:'4K / 2160p', value:'2160', size:'~600 MB' },
        { label:'1080p HD',   value:'1080', size:'~200 MB' },
        { label:'720p HD',    value:'720',  size:'~100 MB' },
        { label:'480p',       value:'480',  size:'~50 MB'  },
      ]
      formats = resOpts
        .filter(o => parseInt(o.value) <= maxH)
        .map(o => ({
          format:'mp4', quality:o.label, value:o.value, size:o.size,
          downloadUrl:`${BASE}/api/download?url=${enc}&format=mp4&quality=${o.value}`,
        }))
      if (formats.length === 0) formats = [{
        format:'mp4', quality:'Best available', value:'best', size:'',
        downloadUrl:`${BASE}/api/download?url=${enc}&format=mp4&quality=best`,
      }]
    }

    res.json({ title, platform, thumbnail: thumb, duration, formats })

  } catch (err) {
    console.error('Info error:', err.message)
    // Graceful fallback — let user still download without metadata
    const BASE = `${req.protocol}://${req.get('host')}`
    const enc  = encodeURIComponent(url)
    const fmts = format === 'mp4'
      ? [
          { format:'mp4', quality:'1080p HD', value:'1080', downloadUrl:`${BASE}/api/download?url=${enc}&format=mp4&quality=1080` },
          { format:'mp4', quality:'720p HD',  value:'720',  downloadUrl:`${BASE}/api/download?url=${enc}&format=mp4&quality=720`  },
        ]
      : [
          { format:'mp3', quality:'320 kbps', value:'320', downloadUrl:`${BASE}/api/download?url=${enc}&format=mp3&quality=320` },
          { format:'mp3', quality:'128 kbps', value:'128', downloadUrl:`${BASE}/api/download?url=${enc}&format=mp3&quality=128` },
        ]
    res.json({ title:'Video', platform: detectPlatform(url), thumbnail:'', duration:'', formats: fmts })
  }
})

// ── GET /api/download — stream file to browser ──────────────────
app.get('/api/download', async (req, res) => {
  const { url, format, quality } = req.query
  if (!url) return res.status(400).json({ error: 'URL is required' })

  const jobId = uuidv4()
  const outTemplate = path.join(TMP_DIR, `${jobId}.%(ext)s`)
  let outFile = null

  try {
    const ytDlp = await getYtDlp()

    if (format === 'mp3') {
      const q = quality || '320'
      await execAsync(
        `${ytDlp} -x --audio-format mp3 --audio-quality ${q}k ` +
        `--no-playlist --no-warnings --no-check-certificate ` +
        `-o "${outTemplate}" "${url}"`,
        { timeout: 180000, maxBuffer: 10 * 1024 * 1024 }
      )
      outFile = path.join(TMP_DIR, `${jobId}.mp3`)
    } else {
      const h = quality === 'best' ? '' : `[height<=${quality || '1080'}]`
      await execAsync(
        `${ytDlp} -f "bestvideo${h}[ext=mp4]+bestaudio[ext=m4a]/bestvideo${h}+bestaudio/best${h}" ` +
        `--merge-output-format mp4 ` +
        `--no-playlist --no-warnings --no-check-certificate ` +
        `-o "${outTemplate}" "${url}"`,
        { timeout: 300000, maxBuffer: 10 * 1024 * 1024 }
      )
      outFile = path.join(TMP_DIR, `${jobId}.mp4`)
    }

    // yt-dlp might have used a different extension
    if (!fs.existsSync(outFile)) {
      const files = fs.readdirSync(TMP_DIR).filter(f => f.startsWith(jobId))
      if (!files.length) throw new Error('Download failed — no output file')
      outFile = path.join(TMP_DIR, files[0])
    }

    const ext      = path.extname(outFile).slice(1)
    const mimeType = ext === 'mp3' ? 'audio/mpeg' : 'video/mp4'
    const size     = fs.statSync(outFile).size

    res.setHeader('Content-Type', mimeType)
    res.setHeader('Content-Disposition', `attachment; filename="snapload.${ext}"`)
    res.setHeader('Content-Length', size)
    res.setHeader('X-File-Size', size)

    const stream = fs.createReadStream(outFile)
    stream.pipe(res)
    stream.on('end', () => setTimeout(() => deleteFiles(outFile), 10000))
    stream.on('error', () => deleteFiles(outFile))

  } catch (err) {
    console.error('Download error:', err.message)
    // Clean partial files
    fs.readdirSync(TMP_DIR).filter(f => f.startsWith(jobId)).forEach(f =>
      deleteFiles(path.join(TMP_DIR, f))
    )
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Download failed' })
  }
})

// ── POST /api/convert — local MP4 file → MP3 ───────────────────
app.post('/api/convert', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })

  const inputPath  = req.file.path
  const quality    = req.body.quality || '320'
  const jobId      = uuidv4()
  const outputPath = path.join(TMP_DIR, `${jobId}.mp3`)
  const origName   = req.file.originalname.replace(/\.[^.]+$/, '.mp3')

  try {
    const ffmpeg = await getFfmpeg()
    await execAsync(
      `${ffmpeg} -i "${inputPath}" -vn -ar 44100 -ac 2 -b:a ${quality}k "${outputPath}"`,
      { timeout: 300000, maxBuffer: 50 * 1024 * 1024 }
    )
    deleteFiles(inputPath)

    if (!fs.existsSync(outputPath)) throw new Error('Conversion produced no output')

    const BASE  = `${req.protocol}://${req.get('host')}`
    const sizeMB = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1)

    res.json({
      ok: true,
      downloadUrl: `${BASE}/api/download-converted/${jobId}.mp3?name=${encodeURIComponent(origName)}`,
      size: `${sizeMB} MB`,
      filename: origName,
    })
  } catch (err) {
    console.error('Convert error:', err.message)
    deleteFiles(inputPath, outputPath)
    res.status(500).json({ error: err.message || 'Conversion failed' })
  }
})

// ── GET /api/download-converted/:file — serve converted file ───
app.get('/api/download-converted/:filename', (req, res) => {
  const safe = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, '')
  const filePath = path.join(TMP_DIR, safe)
  const name = req.query.name || safe

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File expired or not found' })
  }

  res.setHeader('Content-Type', 'audio/mpeg')
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`)
  res.setHeader('Content-Length', fs.statSync(filePath).size)

  const stream = fs.createReadStream(filePath)
  stream.pipe(res)
  stream.on('end', () => setTimeout(() => deleteFiles(filePath), 10000))
})

// ── Start ───────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n${'═'.repeat(54)}`)
  console.log(`  🚀 SnapLoad Backend`)
  console.log(`  📡 http://localhost:${PORT}`)
  console.log(`  📂 Tmp: ${TMP_DIR}`)

  // Check tools on startup
  try { const v = await getYtDlp(); console.log(`  ✅ yt-dlp: ${v}`) }
  catch (e) { console.log(`  ❌ yt-dlp: NOT FOUND — ${e.message}`) }

  try { const v = await getFfmpeg(); console.log(`  ✅ ffmpeg: ${v}`) }
  catch (e) { console.log(`  ❌ ffmpeg: NOT FOUND — ${e.message}`) }

  console.log(`${'═'.repeat(54)}\n`)
})
