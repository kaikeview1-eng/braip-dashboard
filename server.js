const express = require('express')
const cors    = require('cors')
const path    = require('path')

const app  = express()
const PORT = process.env.PORT || 3000

// guarda pedidos em memória (persiste enquanto servidor estiver rodando)
let orders = []

app.use(cors())
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

// ── WEBHOOK recebe dados do Make ──────────────────────────────
app.post('/webhook', (req, res) => {
  const p = req.body
  if (!p) return res.status(400).json({ error: 'body vazio' })

  const status = mapStatus(
    p.shipping_status || p.status || p.order_status || ''
  )

  const order = {
    id:          p.transaction || p.order_id || ('ord_' + Date.now()),
    code:        p.tracking_code || p.rastreio || '',
    name:        p.buyer_name   || p.customer_name || 'Sem nome',
    phone:       p.buyer_phone  || p.phone || '',
    city:        p.buyer_city   || p.city  || '',
    carrier:     p.carrier      || p.transportadora || 'Correios',
    eta:         p.estimated_delivery || p.previsao || '—',
    status,
    rawStatus:   p.status || p.shipping_status || '',
    receivedAt:  Date.now(),
  }

  // atualiza se já existe, senão adiciona
  const idx = orders.findIndex(o => o.id === order.id)
  if (idx >= 0) {
    orders[idx] = { ...orders[idx], ...order }
    console.log(`[UPDATE] ${order.name} → ${order.status}`)
  } else {
    orders.unshift(order)
    console.log(`[NEW]    ${order.name} | ${order.code} | ${order.status}`)
  }

  // mantém no máximo 500 pedidos em memória
  if (orders.length > 500) orders = orders.slice(0, 500)

  res.json({ ok: true, total: orders.length })
})

// ── API retorna pedidos para o dashboard ─────────────────────
app.get('/api/orders', (req, res) => {
  res.json(orders)
})

// ── health check ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', orders: orders.length, uptime: process.uptime() })
})

// ── serve dashboard ───────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

app.listen(PORT, () => {
  console.log(`✅ Braip Dashboard rodando em http://localhost:${PORT}`)
  console.log(`   Webhook: POST /webhook`)
  console.log(`   API:     GET  /api/orders`)
})

// ── mapeamento de status ──────────────────────────────────────
function mapStatus(raw) {
  if (!raw) return 'postado'
  const s = raw.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  if (/aprovado|approved|paid|postado|posted/.test(s))              return 'postado'
  if (/transito|transit|despacho|enviado|shipped|em rota/.test(s))  return 'transito'
  if (/retirada|agencia|disponivel|aguardando|pickup/.test(s))      return 'retirada'
  if (/entregue|entregado|delivered|concluido/.test(s))             return 'entregue'
  if (/problema|falha|failed|nao encontrado|devolvido|recusado/.test(s)) return 'problema'
  return 'postado'
}
