// ═══════════════════════════════════════════════════════════════
//  SnapLoad Backend — Download & Convert Server
//  Runs locally OR deployed on Railway/Render via Docker
// ═══════════════════════════════════════════════════════════════

import express  from 'express'
import cors     from 'cors'
import fs       from 'fs'
import path     from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { fileURLToPath } from 'url'
import multer   from 'multer'
import { v4 as uuidv4 } from 'uuid'
import { createWriteStream } from 'fs'

const execFileAsync = promisify(execFile)

// Safe shell executor — uses execFile (no shell interpolation)
async function runCmd(bin, args, opts = {}) {
  return execFileAsync(bin, args, { ...opts, shell: false })
}

// Platform-specific yt-dlp args for better compatibility
function getPlatformArgs(url) {
  const u = url.toLowerCase()
  const args = []

  if (u.includes('instagram.com')) {
    // Instagram: Android UA works better than desktop — avoids login wall
    args.push(
      '--add-header', 'User-Agent:Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Mobile Safari/537.36',
      '--add-header', 'Accept-Language:en-US,en;q=0.9',
      '--add-header', 'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    )
  }

  if (u.includes('tiktok.com')) {
    args.push(
      '--add-header', 'Referer:https://www.tiktok.com/',
      '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    )
  }

  if (u.includes('twitter.com') || u.includes('x.com')) {
    args.push('--extractor-args', 'twitter:api=legacy')
  }

  if (u.includes('facebook.com') || u.includes('fb.watch')) {
    args.push(
      '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    )
  }

  return args
}
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── Config ─────────────────────────────────────────────────────
// Catch startup errors
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err.message)
  console.error(err.stack)
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason)
})

const PORT    = process.env.PORT || 4000
const TMP_DIR = process.env.TMP_DIR || path.join(__dirname, 'tmp')
const LOG_DIR = path.join(__dirname, 'logs')
const DB_FILE = path.join(LOG_DIR, 'data.json')  // lightweight JSON store

// ── In-memory DB (persisted to data.json) ────────────────────
let _db = { blockedIPs: [], feedback: [] }

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) _db = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'))
    if (!_db.blockedIPs) _db.blockedIPs = []
    if (!_db.feedback)   _db.feedback   = []
  } catch { _db = { blockedIPs: [], feedback: [] } }
}

function saveDB() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(_db, null, 2)) } catch {}
}

// Visitor log (in-memory only, reset on restart)
const visitors = []  // [{ ts, ip, path, ua, country }]
const MAX_VISITORS = 5000

// ── Init storage ─────────────────────────────────────────────
try {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true })
} catch (e) {
  console.warn('Could not create dirs:', e.message)
}
loadDB()

// ── Security Logger ─────────────────────────────────────────

const _logStream = (() => {
  try {
    return createWriteStream(path.join(LOG_DIR, 'security.log'), { flags: 'a' })
  } catch (e) {
    console.warn('Could not open log file:', e.message)
    // Fallback: write to stdout only
    return { write: (s) => process.stdout.write(s) }
  }
})()

function secLog(level, event, data = {}) {
  const entry = {
    ts:    new Date().toISOString(),
    level,
    event,
    ...data,
  }
  _logStream.write(JSON.stringify(entry) + '\n')
  if (level === 'WARN' || level === 'ERROR') {
    console.warn(`[${level}] ${event}`, data)
  }
}

// CORS: allow your Cloudflare Pages domain + localhost dev
// ── CORS config ─────────────────────────────────────────────────
// Allowed origins: localhost + Cloudflare Pages + custom domains
const ALLOWED_ORIGINS = [
  // Local dev
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5200',  // admin dashboard
  'http://127.0.0.1:5200', // admin dashboard
  'http://localhost:4173',
  'http://localhost:3000',
  // Production — your actual Cloudflare Pages domain
  'https://mytools-9ns.pages.dev',
  // Add more domains here if needed:
  // 'https://yourdomain.com',
  // From env vars (Railway/Render environment variables)
  process.env.FRONTEND_URL,
  process.env.FRONTEND_URL_CUSTOM,
].filter(Boolean)

function isAllowedOrigin(origin) {
  if (!origin) return true  // allow curl, Postman, mobile apps
  if (ALLOWED_ORIGINS.includes(origin)) return true
  // Allow all Cloudflare Pages preview deployments: *.pages.dev
  if (origin.endsWith('.pages.dev')) return true
  // Allow all Railway/Render preview deployments
  if (origin.endsWith('.up.railway.app')) return true
  if (origin.endsWith('.onrender.com')) return true
  return false
}

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true })

// ── App ─────────────────────────────────────────────────────────
const app = express()
// Trust Railway/Render reverse proxy — but only 1 hop
app.set('trust proxy', 1)

app.use(cors({
  origin: (origin, cb) => {
    if (isAllowedOrigin(origin)) {
      cb(null, true)
    } else {
      console.warn(`CORS blocked: ${origin}`)
      cb(new Error(`CORS blocked: ${origin}`))
    }
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-token'],
  // Expose download headers — Android/mobile browser cần đọc các header này
  exposedHeaders: ['Content-Disposition', 'Content-Length', 'Content-Type', 'X-File-Size', 'X-Filename'],
  credentials: true,
}))

// Handle preflight OPTIONS requests
app.options('*', cors())

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('X-XSS-Protection', '1; mode=block')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  res.setHeader('Cache-Control', 'no-store')
  res.removeHeader('X-Powered-By')
  next()
})

app.use(express.json({ limit: '2mb' }))  // reduced from 10mb — base64 images handled in admin only

// Rate limiting — per-IP, per-minute, per-endpoint
const reqCount    = new Map()
const activeJobs  = new Map() // track concurrent downloads per IP
const MAX_CONCURRENT = 2     // max 2 simultaneous downloads per IP

function getRateKey(ip, endpoint) {
  return `${ip}|${endpoint}|${Math.floor(Date.now() / 60000)}`
}

function checkRateLimit(ip, endpoint, max) {
  const key = getRateKey(ip, endpoint)
  const cnt = (reqCount.get(key) || 0) + 1
  reqCount.set(key, cnt)
  if (reqCount.size > 1000) {
    const cutoff = Math.floor(Date.now() / 60000) - 2
    for (const [k] of reqCount) {
      const parts = k.split('|')
      if (parseInt(parts[2]) < cutoff) reqCount.delete(k)
    }
  }
  return cnt > max
}

app.use((req, res, next) => {
  const ip  = req.ip || 'unknown'
  const ua  = req.headers['user-agent'] || ''
  const limits = { '/api/download': 10, '/api/convert': 5, '/api/info': 20 }
  const max = limits[req.path] || 60
  if (checkRateLimit(ip, req.path, max)) {
    secLog('WARN', 'RATE_LIMIT', { ip, path: req.path, ua: ua.slice(0, 80) })
    return res.status(429).json({ error: 'Too many requests. Please wait a moment.' })
  }
  next()
})

// NOTE: /tmp is NOT served as static — files are streamed directly via endpoints

// File upload (for convert) — only accept video files, reduced to 200MB
const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['video/mp4','video/x-msvideo','video/quicktime','video/x-matroska','video/webm']
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Only video files are allowed'), false)
    }
    cb(null, true)
  },
})

// ── Tool detection ──────────────────────────────────────────────
let _ytDlp = null
let _ffmpeg = null

async function getYtDlp() {
  if (_ytDlp) return _ytDlp
  for (const cmd of ['yt-dlp', '/usr/local/bin/yt-dlp', 'python3 -m yt_dlp']) {
    try { const [bin,...a] = cmd.split(' '); await runCmd(bin, [...a,'--version'], { timeout: 5000 }); _ytDlp = cmd; return cmd }
    catch { /* try next */ }
  }
  throw new Error('yt-dlp not found. Install: winget install yt-dlp (Windows) or apt install yt-dlp (Linux)')
}

async function getFfmpeg() {
  if (_ffmpeg) return _ffmpeg
  for (const cmd of ['ffmpeg', '/usr/bin/ffmpeg']) {
    try { const [bin,...a] = cmd.split(' '); await runCmd(bin, [...a,'-version'], { timeout: 5000 }); _ffmpeg = cmd; return cmd }
    catch { /* try next */ }
  }
  throw new Error('ffmpeg not found. Install: winget install ffmpeg (Windows) or apt install ffmpeg (Linux)')
}

// ── Security helpers ─────────────────────────────────────────
function isValidHttpUrl(str) {
  try {
    const u = new URL(str)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    const host = u.hostname.toLowerCase()

    // Block all localhost variants
    if (['localhost','127.0.0.1','0.0.0.0','::1','0'].includes(host)) return false
    // Block short IPs like 127.1
    if (/^127\./.test(host)) return false
    // Block private ranges
    if (/^10\./.test(host)) return false
    if (/^192\.168\./.test(host)) return false
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false
    // Block link-local (AWS/GCP metadata)
    if (/^169\.254\./.test(host)) return false
    // Block cloud metadata endpoints
    if (['metadata.google.internal','metadata.goog'].includes(host)) return false
    // Block octal/decimal encoded IPs
    if (/^[0-9]+$/.test(host)) return false          // pure decimal IP
    if (/^0[0-7]/.test(host.split('.')[0])) return false // octal
    // Block IPv6 loopback/private
    if (host.startsWith('[')) {
      const v6 = host.slice(1,-1)
      if (v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd')) return false
    }
    // Must have a real TLD
    if (!host.includes('.') && !host.startsWith('[')) return false
    // Block .local, .internal, .localhost
    if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) return false
    // Block URL credential attacks like http://attacker@127.0.0.1/
    if (u.username || u.password) return false
    return true
  } catch { return false }
}

function sanitizeQuality(q, allowed) {
  return allowed.includes(String(q)) ? String(q) : allowed[0]
}

// ── Helpers ─────────────────────────────────────────────────────
function detectPlatform(url) {
  const map = [
    ['tiktok', 'TikTok'], ['instagram', 'Instagram'],
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

// Health check — responds immediately (Railway requires fast response)
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    server: 'SnapLoad Backend',
    version: '1.0.0',
    uptime: Math.round(process.uptime()),
    port: PORT,
  })
})

// Detailed health (slow, checks tools)
app.get('/api/health/full', async (req, res) => {
  let ytdlp = false, ffmpegOk = false
  try { await getYtDlp(); ytdlp = true } catch { /* not installed */ }
  try { await getFfmpeg(); ffmpegOk = true } catch { /* not installed */ }
  res.json({ ok: true, tools: { ytdlp, ffmpeg: ffmpegOk }, uptime: Math.round(process.uptime()) })
})

// ── POST /api/info — fetch video metadata ───────────────────────
app.post('/api/info', async (req, res) => {
  const { url, format } = req.body
  if (!url) return res.status(400).json({ error: 'URL is required' })
  if (!isValidHttpUrl(url)) {
    secLog('WARN', 'INVALID_URL', { ip: req.ip, url: url.slice(0, 120) })
    return res.status(400).json({ error: 'Invalid or unsafe URL' })
  }

  // Block specific platforms (DMCA compliance)
  if (/youtube\.com|youtu\.be|yt\.be/i.test(url)) {
    secLog('WARN', 'BLOCKED_PLATFORM', { ip: req.ip, reason: 'DMCA' })
    return res.status(451).json({ error: 'This platform is not supported on the web version.' })
  }

  try {
    const ytDlp = await getYtDlp()
    const [ytBin, ...ytArgs] = ytDlp.split(' ')
    const { stdout } = await runCmd(ytBin, [
      ...ytArgs,
      '--dump-json', '--no-playlist', '--no-warnings', '--no-check-certificate',
      ...getPlatformArgs(url), url
    ], { timeout: 30000 })

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
  if (!isValidHttpUrl(url)) {
    secLog('WARN', 'INVALID_URL', { ip: req.ip, url: url.slice(0, 120) })
    return res.status(400).json({ error: 'Invalid or unsafe URL' })
  }
  // Whitelist quality values to prevent injection
  const safeQuality = format === 'mp3'
    ? sanitizeQuality(quality, ['320','256','192','128','best'])
    : sanitizeQuality(quality, ['2160','1080','720','480','best'])
  const safeFormat = ['mp3','mp4'].includes(format) ? format : 'mp3'

  // Enforce concurrent job limit per IP
  const dlIp = req.ip || 'unknown'
  const runningJobs = activeJobs.get(dlIp) || 0
  if (runningJobs >= MAX_CONCURRENT) {
    secLog('WARN', 'CONCURRENT_LIMIT', { ip: dlIp })
    return res.status(429).json({ error: 'Too many concurrent downloads. Please wait for the current one to finish.' })
  }
  activeJobs.set(dlIp, runningJobs + 1)

  const jobId = uuidv4()
  const outTemplate = path.join(TMP_DIR, `${jobId}.%(ext)s`)
  let outFile = null

  const releaseJob = () => {
    const cur = activeJobs.get(dlIp) || 1
    if (cur <= 1) activeJobs.delete(dlIp)
    else activeJobs.set(dlIp, cur - 1)
  }

  try {
    secLog('INFO', 'DOWNLOAD_START', { ip: dlIp, format: safeFormat, quality: safeQuality, jobs: runningJobs + 1 })
    const ytDlp = await getYtDlp()

    if (safeFormat === 'mp3') {
      const q = safeQuality
      const [yb1,...ya1] = ytDlp.split(' ')
      await runCmd(yb1, [
        ...ya1, '-x', '--audio-format', 'mp3', '--audio-quality', `${q}k`,
        '--no-playlist', '--no-warnings', '--no-check-certificate',
        '-o', outTemplate, url
      ], { timeout: 180000, maxBuffer: 10 * 1024 * 1024 })
      outFile = path.join(TMP_DIR, `${jobId}.mp3`)
    } else {
      const fmtStr = safeQuality === 'best'
        ? 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best'
        : `bestvideo[height<=${safeQuality}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${safeQuality}]+bestaudio/best[height<=${safeQuality}]`
      const [yb2,...ya2] = ytDlp.split(' ')
      await runCmd(yb2, [
        ...ya2, '-f', fmtStr, '--merge-output-format', 'mp4',
        '--no-playlist', '--no-warnings', '--no-check-certificate',
        '-o', outTemplate, url
      ], { timeout: 300000, maxBuffer: 10 * 1024 * 1024 })
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
    const dlName   = `snapload.${ext}`

    res.setHeader('Content-Type', mimeType)
    // filename* (RFC 5987) cho Android Chrome đọc đúng tên file
    res.setHeader('Content-Disposition', `attachment; filename="${dlName}"; filename*=UTF-8''${encodeURIComponent(dlName)}`)
    res.setHeader('Content-Length', size)
    res.setHeader('X-File-Size', size)
    // X-Filename: frontend dùng để tải blob với đúng tên file
    res.setHeader('X-Filename', dlName)

    const stream = fs.createReadStream(outFile)
    stream.pipe(res)
    stream.on('end', () => {
      releaseJob()
      secLog('INFO', 'DOWNLOAD_DONE', { ip: dlIp, size, format: safeFormat })
      setTimeout(() => deleteFiles(outFile), 10000)
    })
    stream.on('error', (e) => {
      releaseJob()
      secLog('ERROR', 'STREAM_ERROR', { ip: dlIp, msg: e.message })
      deleteFiles(outFile)
    })

  } catch (err) {
    releaseJob()
    secLog('ERROR', 'DOWNLOAD_FAIL', { ip: dlIp, msg: err.message.slice(0, 200) })
    fs.readdirSync(TMP_DIR).filter(f => f.startsWith(jobId)).forEach(f =>
      deleteFiles(path.join(TMP_DIR, f))
    )
    if (!res.headersSent) res.status(500).json({ error: 'Download failed. Please try again.' })
  }
})

// ── POST /api/convert — local MP4 file → MP3 ───────────────────
app.post('/api/convert', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })

  const inputPath  = req.file.path
  const quality    = sanitizeQuality(req.body.quality, ['320','256','192','128'])
  const jobId      = uuidv4()
  const outputPath = path.join(TMP_DIR, `${jobId}.mp3`)
  const origName   = req.file.originalname.replace(/[^\w\s.-]/g, '').replace(/\.[^.]+$/, '').slice(0, 100) + '.mp3'

  // ── Magic bytes validation — verify file is actually a video ──
  // MIME type header is trivially spoofed; check actual file signature
  try {
    const buf = Buffer.alloc(12)
    const fd  = fs.openSync(inputPath, 'r')
    fs.readSync(fd, buf, 0, 12, 0)
    fs.closeSync(fd)

    const isMp4  = buf.slice(4, 8).toString('ascii') === 'ftyp'          // MP4/MOV
    const isMkv  = buf[0] === 0x1A && buf[1] === 0x45                    // MKV/WebM
    const isAvi  = buf.slice(0, 4).toString('ascii') === 'RIFF'          // AVI
    const isMpeg = buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 // MPEG
    const isFlv  = buf.slice(0, 3).toString('ascii') === 'FLV'           // FLV

    if (!isMp4 && !isMkv && !isAvi && !isMpeg && !isFlv) {
      deleteFiles(inputPath)
      secLog('WARN', 'INVALID_MAGIC_BYTES', { ip: req.ip, mime: req.file.mimetype, hex: buf.slice(0,8).toString('hex') })
      return res.status(400).json({ error: 'Invalid file — not a recognized video format' })
    }
  } catch (magicErr) {
    deleteFiles(inputPath)
    return res.status(400).json({ error: 'Could not read uploaded file' })
  }

  try {
    secLog('INFO', 'CONVERT_START', { ip: req.ip, size: req.file.size, quality })
    const ffmpeg = await getFfmpeg()
    const [ffBin,...ffArgs] = ffmpeg.split(' ')
    await runCmd(ffBin, [
      ...ffArgs, '-i', inputPath, '-vn', '-ar', '44100', '-ac', '2', '-b:a', `${quality}k`, outputPath
    ], { timeout: 300000, maxBuffer: 50 * 1024 * 1024 })
    deleteFiles(inputPath)

    if (!fs.existsSync(outputPath)) throw new Error('Conversion produced no output')

    const BASE  = `${req.protocol}://${req.get('host')}`
    const sizeMB = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1)

    secLog('INFO', 'CONVERT_DONE', { ip: req.ip, sizeMB })
    res.json({
      ok: true,
      downloadUrl: `${BASE}/api/download-converted/${jobId}.mp3?name=${encodeURIComponent(origName)}`,
      size: `${sizeMB} MB`,
      filename: origName,
    })
  } catch (err) {
    secLog('ERROR', 'CONVERT_FAIL', { ip: req.ip, msg: err.message.slice(0, 200) })
    deleteFiles(inputPath, outputPath)
    res.status(500).json({ error: 'Conversion failed. Please try again.' })
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

  // Only serve .mp3 files from this endpoint
  if (!safe.endsWith('.mp3')) return res.status(400).json({ error: 'Invalid file type' })
  res.setHeader('Content-Type', 'audio/mpeg')
  const safeDlName = name.replace(/[^\w\s.-]/g, '').slice(0, 100) + '.mp3'
  res.setHeader('Content-Disposition', `attachment; filename="${safeDlName}"`)
  res.setHeader('Content-Length', fs.statSync(filePath).size)

  const stream = fs.createReadStream(filePath)
  stream.pipe(res)
  stream.on('end', () => setTimeout(() => deleteFiles(filePath), 10000))
})

// ── GET /api/logs — read log (admin only via ADMIN_TOKEN) ──────
const BACKEND_ADMIN_TOKEN = process.env.ADMIN_TOKEN || null

function requireAdminToken(req, res, next) {
  if (!BACKEND_ADMIN_TOKEN) return next() // no token set = open (local dev only)
  const token = req.headers['x-admin-token'] || req.query.token
  if (token !== BACKEND_ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}

app.get('/api/logs', requireAdminToken, (req, res) => {
  try {
    const logFile = path.join(LOG_DIR, 'security.log')
    if (!fs.existsSync(logFile)) return res.json({ ok: true, logs: [], total: 0 })

    const limit = Math.min(parseInt(req.query.limit || '200'), 500)
    const level = req.query.level || ''

    const lines  = fs.readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean)
    const parsed = []
    for (const line of lines) {
      try {
        const e = JSON.parse(line)
        if (level && e.level !== level) continue
        parsed.push(e)
      } catch { /* skip */ }
    }

    res.json({ ok: true, logs: parsed.reverse().slice(0, limit), total: parsed.length })
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Could not read logs' })
  }
})

app.delete('/api/logs', requireAdminToken, (req, res) => {
  try {
    const logFile = path.join(LOG_DIR, 'security.log')
    if (fs.existsSync(logFile)) {
      fs.copyFileSync(logFile, logFile + '.bak')
      fs.writeFileSync(logFile, '', 'utf-8')
    }
    res.json({ ok: true, message: 'Logs cleared' })
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Could not clear logs' })
  }
})

app.get('/api/stats', requireAdminToken, (req, res) => {
  try {
    const logFile = path.join(LOG_DIR, 'security.log')
    if (!fs.existsSync(logFile)) return res.json({ ok: true, stats: { total:0, warn:0, error:0, events:{}, topIps:[], hourly:[] } })

    const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean)
    let total = 0, warn = 0, error = 0
    const events = {}, ips = {}, byHour = {}

    for (const line of lines) {
      try {
        const e = JSON.parse(line)
        total++
        if (e.level === 'WARN')  warn++
        if (e.level === 'ERROR') error++
        events[e.event] = (events[e.event] || 0) + 1
        if (e.ip) ips[e.ip] = (ips[e.ip] || 0) + 1
        const h = new Date(e.ts).getHours()
        byHour[h] = (byHour[h] || 0) + 1
      } catch { /* skip */ }
    }

    const topIps = Object.entries(ips).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([ip,count])=>({ip,count}))
    const hourly = Array.from({length:24},(_,h)=>({h,count:byHour[h]||0}))

    res.json({ ok: true, stats: { total, warn, error, events, topIps, hourly } })
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Could not compute stats' })
  }
})

// ── POST /api/pageview — lightweight page view ping (public) ──
app.post('/api/pageview', (req, res) => {
  const { path: pagePath, ref } = req.body || {}
  const entry = {
    ts:   new Date().toISOString(),
    ip:   req.ip || 'unknown',
    path: (pagePath || '/').slice(0, 80),
    ua:   (req.headers['user-agent'] || '').slice(0, 120),
    ref:  (ref || req.headers['referer'] || '').slice(0, 80),
    type: 'pageview',
  }
  visitors.push(entry)
  if (visitors.length > MAX_VISITORS) visitors.splice(0, visitors.length - MAX_VISITORS)
  res.json({ ok: true })
})

// ── GET /api/visitors — visitor stats ────────────────────────
app.get('/api/visitors', requireAdminToken, (req, res) => {
  const limit = parseInt(req.query.limit || '200')
  const recent = [...visitors].reverse().slice(0, limit)

  // Stats
  const ipCounts = {}
  const pathCounts = {}
  const hourly = Array.from({length:24}, (_,h) => ({h, count:0}))
  const last24h = Date.now() - 86400000

  visitors.forEach(v => {
    ipCounts[v.ip]     = (ipCounts[v.ip]     || 0) + 1
    pathCounts[v.path] = (pathCounts[v.path] || 0) + 1
    if (new Date(v.ts).getTime() > last24h) {
      const h = new Date(v.ts).getHours()
      hourly[h].count++
    }
  })

  const topIPs = Object.entries(ipCounts)
    .sort((a,b) => b[1]-a[1]).slice(0,20)
    .map(([ip,count]) => ({ ip, count, blocked: _db.blockedIPs.includes(ip) }))

  res.json({
    ok: true,
    total: visitors.length,
    recent,
    topIPs,
    pathCounts,
    hourly,
    blockedIPs: _db.blockedIPs,
  })
})

// ── POST /api/block-ip — block an IP ──────────────────────────
app.post('/api/block-ip', requireAdminToken, (req, res) => {
  const { ip } = req.body
  if (!ip) return res.status(400).json({ ok: false, error: 'IP required' })
  if (!_db.blockedIPs.includes(ip)) {
    _db.blockedIPs.push(ip)
    saveDB()
    secLog('INFO', 'IP_BLOCKED', { ip, by: 'admin' })
  }
  res.json({ ok: true, blocked: _db.blockedIPs })
})

// ── DELETE /api/block-ip — unblock an IP ─────────────────────
app.delete('/api/block-ip', requireAdminToken, (req, res) => {
  const { ip } = req.body
  if (!ip) return res.status(400).json({ ok: false, error: 'IP required' })
  _db.blockedIPs = _db.blockedIPs.filter(b => b !== ip)
  saveDB()
  secLog('INFO', 'IP_UNBLOCKED', { ip, by: 'admin' })
  res.json({ ok: true, blocked: _db.blockedIPs })
})

// ── POST /api/feedback — user submits feedback ────────────────
app.post('/api/feedback', (req, res) => {
  const { message, name, email, type } = req.body
  if (!message?.trim()) return res.status(400).json({ ok: false, error: 'Message required' })

  const entry = {
    id:      Date.now().toString(36),
    ts:      new Date().toISOString(),
    ip:      req.ip || 'unknown',
    name:    (name    || 'Anonymous').slice(0, 50),
    email:   (email   || '').slice(0, 100),
    type:    ['bug', 'feature', 'other'].includes(type) ? type : 'other',
    message: message.trim().slice(0, 1000),
    read:    false,
  }

  _db.feedback.unshift(entry)
  if (_db.feedback.length > 500) _db.feedback = _db.feedback.slice(0, 500)
  saveDB()
  secLog('INFO', 'FEEDBACK_RECEIVED', { ip: entry.ip, type: entry.type })
  res.json({ ok: true, id: entry.id })
})

// ── GET /api/feedback — list feedback (admin) ────────────────
app.get('/api/feedback', requireAdminToken, (req, res) => {
  const unread = _db.feedback.filter(f => !f.read).length
  res.json({ ok: true, feedback: _db.feedback, unread })
})

// ── PATCH /api/feedback/:id — mark as read ────────────────────
app.patch('/api/feedback/:id', requireAdminToken, (req, res) => {
  const item = _db.feedback.find(f => f.id === req.params.id)
  if (!item) return res.status(404).json({ ok: false, error: 'Not found' })
  item.read = true
  saveDB()
  res.json({ ok: true })
})

// ── DELETE /api/feedback/:id — delete feedback ────────────────
app.delete('/api/feedback/:id', requireAdminToken, (req, res) => {
  _db.feedback = _db.feedback.filter(f => f.id !== req.params.id)
  saveDB()
  res.json({ ok: true })
})



app.get('/api/logs', requireAdminToken, (req, res) => {
  try {
    const logFile = path.join(LOG_DIR, 'security.log')
    if (!fs.existsSync(logFile)) return res.json({ ok: true, logs: [], total: 0 })

    const limit = Math.min(parseInt(req.query.limit || '200'), 500)
    const level = req.query.level || ''

    const lines  = fs.readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean)
    const parsed = []
    for (const line of lines) {
      try {
        const e = JSON.parse(line)
        if (level && e.level !== level) continue
        parsed.push(e)
      } catch { /* skip */ }
    }

    res.json({ ok: true, logs: parsed.reverse().slice(0, limit), total: parsed.length })
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Could not read logs' })
  }
})

app.delete('/api/logs', requireAdminToken, (req, res) => {
  try {
    const logFile = path.join(LOG_DIR, 'security.log')
    if (fs.existsSync(logFile)) {
      fs.copyFileSync(logFile, logFile + '.bak')
      fs.writeFileSync(logFile, '', 'utf-8')
    }
    res.json({ ok: true, message: 'Logs cleared' })
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Could not clear logs' })
  }
})

app.get('/api/stats', requireAdminToken, (req, res) => {
  try {
    const logFile = path.join(LOG_DIR, 'security.log')
    if (!fs.existsSync(logFile)) return res.json({ ok: true, stats: { total:0, warn:0, error:0, events:{}, topIps:[], hourly:[] } })

    const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean)
    let total = 0, warn = 0, error = 0
    const events = {}, ips = {}, byHour = {}

    for (const line of lines) {
      try {
        const e = JSON.parse(line)
        total++
        if (e.level === 'WARN')  warn++
        if (e.level === 'ERROR') error++
        events[e.event] = (events[e.event] || 0) + 1
        if (e.ip) ips[e.ip] = (ips[e.ip] || 0) + 1
        const h = new Date(e.ts).getHours()
        byHour[h] = (byHour[h] || 0) + 1
      } catch { /* skip */ }
    }

    const topIps = Object.entries(ips).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([ip,count])=>({ip,count}))
    const hourly = Array.from({length:24},(_,h)=>({h,count:byHour[h]||0}))

    res.json({ ok: true, stats: { total, warn, error, events, topIps, hourly } })
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Could not compute stats' })
  }
})

// ── POST /api/playlist — fetch playlist metadata ────────────────
app.post('/api/playlist', async (req, res) => {
  const { url } = req.body
  if (!url) return res.status(400).json({ error: 'URL is required' })
  if (!isValidHttpUrl(url)) return res.status(400).json({ error: 'Invalid or unsafe URL' })

  const isPlaylist = url.includes('list=') || url.includes('/playlist') || url.includes('/@') || url.includes('/channel')
  if (!isPlaylist) return res.status(400).json({ error: 'Không phải link playlist. Dùng /api/info cho video đơn.' })

  // Allow configurable max items (from admin config, default 200, max 500)
  const rawMax  = parseInt(req.body.maxItems || req.query.maxItems || '200')
  const maxItems = Math.min(Math.max(rawMax, 10), 500)

  try {
    const ytDlp = await getYtDlp()
    const [ytBin, ...ytArgs] = ytDlp.split(' ')
    const { stdout } = await runCmd(ytBin, [
      ...ytArgs,
      '--flat-playlist', '--dump-json', '--no-warnings', '--no-check-certificate',
      '--playlist-end', String(maxItems), // configurable max
      ...getPlatformArgs(url),
      url
    ], { timeout: 60000, maxBuffer: 50 * 1024 * 1024 })

    const lines = stdout.trim().split('\n').filter(Boolean)
    const items = []
    for (const line of lines) {
      try {
        const v = JSON.parse(line)
        // Normalize to full URL
        let videoUrl = v.webpage_url || v.url || ''
        if (!videoUrl.startsWith('http') && v.id) {
          videoUrl = `https://www.tiktok.com/video/${v.id}`
        }
        // Remove any double-encoding
        try { videoUrl = decodeURIComponent(videoUrl) } catch {}

        items.push({
          id:       v.id,
          title:    v.title || v.id,
          duration: v.duration ? `${Math.floor(v.duration/60)}:${String(v.duration%60).padStart(2,'0')}` : '',
          thumb:    v.thumbnail || v.thumbnails?.[0]?.url || '',
          url:      videoUrl,
        })
      } catch {}
    }

    if (!items.length) return res.status(400).json({ error: 'Không tìm thấy video trong playlist' })

    res.json({ ok: true, total: items.length, items })
  } catch (err) {
    secLog('ERROR', 'PLAYLIST_FAIL', { ip: req.ip, msg: err.message.slice(0, 200) })
    res.status(500).json({ error: 'Không thể đọc playlist. Kiểm tra link có đúng không.' })
  }
})

// ── POST /api/batch-info — fetch multiple URLs info ──────────────
app.post('/api/batch-info', async (req, res) => {
  const { urls } = req.body
  if (!Array.isArray(urls) || !urls.length) return res.status(400).json({ error: 'urls array required' })
  const safeUrls = urls.filter(u => u && isValidHttpUrl(u)).slice(0, 20) // max 20
  if (!safeUrls.length) return res.status(400).json({ error: 'No valid URLs' })

  const BASE = `${req.protocol}://${req.get('host')}`
  const results = []

  for (const url of safeUrls) {
    try {
      const ytDlp = await getYtDlp()
      const [ytBin, ...ytArgs] = ytDlp.split(' ')
      const { stdout } = await runCmd(ytBin, [
        ...ytArgs, '--dump-json', '--no-playlist', '--no-warnings', '--no-check-certificate',
        ...getPlatformArgs(url), url
      ], { timeout: 20000 })
      const info = JSON.parse(stdout.trim().split('\n')[0])
      const enc  = encodeURIComponent(url)
      results.push({
        url, ok: true,
        title:    info.title || 'Video',
        thumb:    info.thumbnail || '',
        duration: info.duration ? `${Math.floor(info.duration/60)}:${String(info.duration%60).padStart(2,'0')}` : '',
        platform: detectPlatform(url),
        mp3Url:   `${BASE}/api/download?url=${enc}&format=mp3&quality=320`,
        mp4Url:   `${BASE}/api/download?url=${enc}&format=mp4&quality=1080`,
      })
    } catch (err) {
      results.push({ url, ok: false, error: 'Không tải được video này' })
    }
  }

  res.json({ ok: true, results })
})

// ── GET /api/subtitle-zip-status — SSE progress stream ──────────
// (kept simple — frontend polls via SSE)
const zipJobs = new Map() // jobId → { total, done, errors }

// ── POST /api/tag — apply ID3 tags then stream file ─────────────
// Accepts: { url, format, quality, title, artist, album, year, genre }
// Downloads the file (or uses existing), applies ffmpeg metadata, streams back
app.post('/api/tag', async (req, res) => {
  const { url, format = 'mp3', quality = '320',
          title = '', artist = '', album = '', year = '', genre = '' } = req.body

  if (!url) return res.status(400).json({ error: 'URL required' })
  if (!isValidHttpUrl(url)) return res.status(400).json({ error: 'Invalid URL' })

  const safeFormat  = format === 'mp3' ? 'mp3' : 'mp4'
  const safeQuality = safeFormat === 'mp3'
    ? (sanitizeQuality(quality, ['320','256','192','128']))
    : (sanitizeQuality(quality, ['2160','1080','720','480']))

  // Sanitize tag values — no shell injection
  function sanitizeTag(v) { return String(v || '').replace(/["\\]/g, '').slice(0, 200) }
  const tags = {
    title:  sanitizeTag(title),
    artist: sanitizeTag(artist),
    album:  sanitizeTag(album),
    year:   sanitizeTag(year).replace(/[^0-9]/g, '').slice(0, 4),
    genre:  sanitizeTag(genre),
  }

  // Only MP3 supports ID3 tags properly
  if (safeFormat !== 'mp3') {
    return res.status(400).json({ error: 'ID3 tags chỉ hỗ trợ cho MP3' })
  }

  const jobId      = uuidv4()
  const rawFile    = path.join(TMP_DIR, `${jobId}_raw.mp3`)
  const taggedFile = path.join(TMP_DIR, `${jobId}_tagged.mp3`)
  const outTemplate = path.join(TMP_DIR, `${jobId}_raw.%(ext)s`)

  secLog('INFO', 'TAG_START', { ip: req.ip, title: tags.title, artist: tags.artist })

  try {
    const ytDlp = await getYtDlp()
    const ffmpeg = await getFfmpeg()

    // Step 1: Download MP3
    const [ytBin, ...ytArgs] = ytDlp.split(' ')
    await runCmd(ytBin, [
      ...ytArgs, '-x', '--audio-format', 'mp3',
      '--audio-quality', `${safeQuality}k`,
      '--no-playlist', '--no-warnings', '--no-check-certificate',
      ...getPlatformArgs(url),
      '-o', outTemplate, url,
    ], { timeout: 300000, maxBuffer: 50 * 1024 * 1024 })

    // Find actual downloaded file
    let srcFile = rawFile
    if (!fs.existsSync(srcFile)) {
      const found = fs.readdirSync(TMP_DIR).filter(f => f.startsWith(`${jobId}_raw`))
      if (!found.length) throw new Error('Download failed')
      srcFile = path.join(TMP_DIR, found[0])
    }

    // Step 2: Apply ID3 tags using ffmpeg metadata
    const metadataArgs = []
    if (tags.title)  metadataArgs.push('-metadata', `title=${tags.title}`)
    if (tags.artist) metadataArgs.push('-metadata', `artist=${tags.artist}`)
    if (tags.album)  metadataArgs.push('-metadata', `album=${tags.album}`)
    if (tags.year)   metadataArgs.push('-metadata', `date=${tags.year}`)
    if (tags.genre)  metadataArgs.push('-metadata', `genre=${tags.genre}`)

    const [ffBin, ...ffArgs] = ffmpeg.split(' ')
    await runCmd(ffBin, [
      ...ffArgs,
      '-i', srcFile,
      '-c', 'copy',          // copy audio stream — no re-encode
      ...metadataArgs,
      '-id3v2_version', '3', // compatible ID3v2.3
      '-y', taggedFile,
    ], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 })

    const finalFile = fs.existsSync(taggedFile) ? taggedFile : srcFile
    const size      = fs.statSync(finalFile).size

    // Build filename from tags
    const safeName  = (tags.artist && tags.title)
      ? `${tags.artist} - ${tags.title}`.replace(/[^\w\s\-().]/g, '').slice(0, 100)
      : (tags.title || 'snapload').replace(/[^\w\s\-().]/g, '').slice(0, 100)

    res.setHeader('Content-Type', 'audio/mpeg')
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.mp3"; filename*=UTF-8''${encodeURIComponent(safeName)}.mp3`)
    res.setHeader('Content-Length', String(size))
    res.setHeader('X-File-Size', String(size))

    const stream = fs.createReadStream(finalFile)
    stream.pipe(res)
    stream.on('end', () => {
      secLog('INFO', 'TAG_DONE', { ip: req.ip, size })
      setTimeout(() => {
        try { deleteFiles(srcFile, taggedFile) } catch {}
      }, 15000)
    })
    stream.on('error', (e) => {
      secLog('ERROR', 'TAG_STREAM_ERROR', { msg: e.message })
      try { deleteFiles(srcFile, taggedFile) } catch {}
    })

  } catch (err) {
    secLog('ERROR', 'TAG_FAIL', { ip: req.ip, msg: err.message.slice(0, 200) })
    try { deleteFiles(rawFile, taggedFile) } catch {}
    if (!res.headersSent) res.status(500).json({ error: 'Không thể áp dụng tag: ' + err.message.slice(0, 100) })
  }
})

// ── GET /api/subtitle — download subtitle ────────────────────────
app.get('/api/subtitle', async (req, res) => {
  const { url, lang = 'vi,en', fmt = 'srt' } = req.query
  if (!url) return res.status(400).json({ error: 'URL required' })
  if (!isValidHttpUrl(url)) return res.status(400).json({ error: 'Invalid URL' })

  const jobId  = uuidv4()
  const outDir = TMP_DIR
  const safeFormat = ['srt','vtt','ass','json3'].includes(fmt) ? fmt : 'srt'

  try {
    const ytDlp = await getYtDlp()
    const [ytBin, ...ytArgs] = ytDlp.split(' ')

    await runCmd(ytBin, [
      ...ytArgs,
      '--write-subs', '--write-auto-subs',
      '--sub-langs', lang,
      '--sub-format', safeFormat,
      '--skip-download',
      '--no-warnings', '--no-check-certificate',
      '-o', path.join(outDir, `${jobId}.%(ext)s`),
      url
    ], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 })

    
    const files = fs.readdirSync(outDir).filter(f => f.startsWith(jobId) && !f.endsWith('.mp3') && !f.endsWith('.mp4'))
    if (!files.length) return res.status(404).json({ error: 'Không tìm thấy phụ đề cho video này' })

    const subFile = path.join(outDir, files[0])
    const ext     = path.extname(files[0]).slice(1)
    const mimeTypes = { srt: 'text/plain', vtt: 'text/vtt', ass: 'text/plain', json3: 'application/json' }

    res.setHeader('Content-Type', mimeTypes[ext] || 'text/plain')
    res.setHeader('Content-Disposition', `attachment; filename="subtitle.${ext}"`)
    const stream = fs.createReadStream(subFile)
    stream.pipe(res)
    stream.on('end', () => setTimeout(() => deleteFiles(subFile), 30000))
  } catch (err) {
    secLog('ERROR', 'SUBTITLE_FAIL', { ip: req.ip, msg: err.message.slice(0, 100) })
    res.status(500).json({ error: 'Không tải được phụ đề. Video có thể không có phụ đề.' })
  }
})

//  Start
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n${'═'.repeat(54)}`)
  console.log(`  🚀 SnapLoad Backend — listening on port ${PORT}`)
  console.log(`  📡 http://0.0.0.0:${PORT}`)
  console.log(`  📂 Tmp: ${TMP_DIR}`)
  console.log(`  ✅ Ready to accept requests`)
  console.log(`${'═'.repeat(54)}\n`)

  // Check tools AFTER server is already listening (non-blocking)
  Promise.all([
    getYtDlp().then(v  => console.log(`  ✅ yt-dlp:  ${v}`))
              .catch(e => console.log(`  ❌ yt-dlp:  NOT FOUND — ${e.message}`)),
    getFfmpeg().then(v  => console.log(`  ✅ ffmpeg:  ${v}`))
              .catch(e => console.log(`  ❌ ffmpeg:  NOT FOUND — ${e.message}`)),
  ])
})

server.on('error', (err) => {
  console.error('Server error:', err.message)
  process.exit(1)
})
