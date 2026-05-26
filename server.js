const express = require('express')
const cors    = require('cors')
const path    = require('path')

const app  = express()
const PORT = process.env.PORT || 3000

// ── SUPABASE ──────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL // configurado no Render
const SUPABASE_KEY = process.env.SUPABASE_KEY // configurado no Render

async function sbFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...options,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': options.prefer || 'return=representation',
      ...(options.headers || {})
    }
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Supabase error: ${res.status} ${err}`)
  }
  const text = await res.text()
  return text ? JSON.parse(text) : []
}

// cache em memória para respostas rápidas
let cache = []
let cacheTs = 0

async function loadCache() {
  try {
    cache = await sbFetch('/orders?order=received_at.desc&limit=500')
    cacheTs = Date.now()
  } catch(e) {
    console.error('[CACHE] erro ao carregar:', e.message)
  }
}

app.use(cors())
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

// ── WEBHOOK recebe dados do Make ──────────────────────────────
app.post('/webhook', async (req, res) => {
  const p = req.body
  if (!p) return res.status(400).json({ error: 'body vazio' })

  const status = mapStatus(p.shipping_status || p.status || p.order_status || p.type || '')
  const order = {
    transaction_id: p.transaction || p.order_id || ('ord_' + Date.now()),
    code:           (p.tracking_code || p.rastreio || '').trim(),
    name:           p.buyer_name   || p.client_name || p.customer_name || 'Sem nome',
    phone:          p.buyer_phone  || p.client_cel  || p.phone || '',
    city:           p.buyer_city   || p.client_address_city || p.city || '',
    carrier:        p.carrier      || p.shipping_company || 'Correios',
    eta:            p.estimated_delivery || p.previsao || '—',
    valor:          p.trans_value ? p.trans_value / 100 : 0,
    status,
    raw_status:     p.status || p.type || p.shipping_status || '',
    received_at:    Date.now(),
  }

  try {
    // tenta upsert pelo transaction_id
    await sbFetch('/orders', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=representation',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(order)
    })
    console.log(`[DB] ${order.name} → ${order.status}`)
  } catch(e) {
    console.error('[DB] erro no upsert:', e.message)
    // fallback: salva em memória mesmo se Supabase falhar
    const idx = cache.findIndex(o => o.transaction_id === order.transaction_id)
    if (idx >= 0) cache[idx] = { ...cache[idx], ...order }
    else cache.unshift(order)
  }

  await loadCache()
  res.json({ ok: true, total: cache.length })
})

// ── EDITAR STATUS ─────────────────────────────────────────────
app.patch('/api/orders/:id/status', async (req, res) => {
  const { id } = req.params
  const { status } = req.body
  const valid = ['postado','transito','retirada','entregue','problema']
  if (!valid.includes(status)) return res.status(400).json({ error: 'status inválido' })

  try {
    await sbFetch(`/orders?transaction_id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status })
    })
    await loadCache()
    res.json({ ok: true })
  } catch(e) {
    // fallback memória
    const idx = cache.findIndex(o => o.transaction_id === id || o.id === id)
    if (idx >= 0) { cache[idx].status = status; res.json({ ok: true }) }
    else res.status(404).json({ error: 'não encontrado' })
  }
})

// ── API retorna pedidos ───────────────────────────────────────
app.get('/api/orders', async (req, res) => {
  // recarrega cache se tiver mais de 30s
  if (Date.now() - cacheTs > 30000) await loadCache()
  res.json(cache)
})

// ── IMPORTAR RASTREIOS NO SEU RASTREIO ───────────────────────
app.post('/importar-rastreios', async (req, res) => {
  const SR_KEY = req.body.key || process.env.SR_KEY
  if (!SR_KEY) return res.status(400).json({ error: 'key obrigatória' })

  res.json({ ok: true, message: 'Importação iniciada — acompanhe os logs do Render' })

  ;(async () => {
    console.log('[IMPORT] Buscando pedidos do Supabase...')
    let orders = []
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/orders?select=code,name,phone,transaction_id&code=not.eq.&status=in.(postado,transito,retirada)`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      })
      orders = await r.json()
    } catch(e) { console.error('[IMPORT] Erro Supabase:', e.message); return }

    const codes = orders.filter(o => o.code && o.code.trim())
    console.log(`[IMPORT] ${codes.length} pedidos para cadastrar`)

    let success = 0, skipped = 0, errors = 0

    for (const order of codes) {
      const code = order.code.trim()
      const name = (order.name || '').slice(0, 80)
      const phone = (order.phone || '').replace(/\D/g, '')
      const txn = order.transaction_id || code

      const payload = { externalId: txn, trackingCode: code, trackingCarrier: 'Correios', customerName: name, status: 'shipped' }
      if (phone && phone.length >= 10) payload.phone = phone

      try {
        const r = await fetch('https://seurastreio.com.br/api/public/pedidos', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${SR_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })
        if (r.ok) { success++ }
        else {
          const txt = await r.text()
          if (r.status === 409 || txt.includes('exist') || txt.includes('duplicad')) skipped++
          else { errors++; if(errors<=5) console.log(`[IMPORT] Erro ${r.status} em ${code}: ${txt.slice(0,100)}`) }
        }
      } catch(e) { errors++; if(errors<=3) console.log(`[IMPORT] Erro em ${code}: ${e.message}`) }

      await new Promise(r => setTimeout(r, 1200))
    }
    console.log(`[IMPORT] ✅ Sucesso: ${success} | ⏭ Existiam: ${skipped} | ❌ Erros: ${errors}`)
  })()
})

// ── health check ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', orders: cache.length, uptime: Math.floor(process.uptime()), db: 'supabase' })
})

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

// ── INIT ──────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`✅ Braip Dashboard → http://localhost:${PORT}`)
  console.log(`   DB: Supabase (${SUPABASE_URL})`)
  await loadCache()
  console.log(`   Cache: ${cache.length} pedidos carregados`)
})

// ── mapeamento de status ──────────────────────────────────────
function mapStatus(raw) {
  if (!raw) return 'postado'
  const s = raw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  if (s.includes('delivered'))                                     return 'entregue'
  if (s.includes('waiting_withdrawal') || s.includes('aguardando_retirada')) return 'retirada'
  if (s.includes('out_for_delivery')   || s.includes('saiu_para_entrega'))   return 'transito'
  if (s.includes('returned') || s.includes('devolvido') || s.includes('incorreto') || s.includes('atraso')) return 'problema'
  if (s.includes('tracking_status'))                               return 'transito'
  if (/aprovado|approved|paid|postado|posted/.test(s))             return 'postado'
  if (/transito|transit|despacho|enviado|shipped/.test(s))         return 'transito'
  if (/retirada|agencia|disponivel|aguardando|pickup/.test(s))     return 'retirada'
  if (/entregue|entregado|concluido/.test(s))                      return 'entregue'
  if (/problema|falha|failed|nao encontrado|recusado/.test(s))     return 'problema'
  return 'postado'
}
