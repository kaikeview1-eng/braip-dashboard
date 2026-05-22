# Braip Dashboard — Servidor

Dashboard de rastreio integrado com Braip via webhook.

## Estrutura
```
braip-dashboard-server/
├── server.js          ← servidor Node.js
├── package.json
├── .gitignore
└── public/
    └── index.html     ← dashboard
```

## Como subir no Render (grátis)

1. Crie conta em **render.com**
2. Clique em **New → Web Service**
3. Conecte ao GitHub e faça upload desta pasta como repositório
4. Configure:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Environment:** Node
5. Clique em **Deploy**
6. Sua URL será: `https://braip-dashboard.onrender.com`

## Webhook

Configure no Make o módulo HTTP com a URL:
```
https://SEU-APP.onrender.com/webhook
```

A Braip → Make → POST /webhook → dashboard atualiza a cada 10s.
