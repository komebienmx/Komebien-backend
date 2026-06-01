const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, CORS);
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, CORS);
    res.end(JSON.stringify({ status: 'ok', service: 'Komebien API' }));
    return;
  }

  // Firebase config endpoint
  if (req.method === 'GET' && req.url === '/config') {
    res.writeHead(200, CORS);
    res.end(JSON.stringify({
      apiKey: FIREBASE_API_KEY || '',
      authDomain: "komebienmx.firebaseapp.com",
      projectId: "komebienmx",
      storageBucket: "komebienmx.firebasestorage.app",
      messagingSenderId: "465748859151",
      appId: "1:465748859151:web:1b7ace721717434ed9467a"
    }));
    return;
  }

  // Claude API proxy
  if (req.method === 'POST' && req.url === '/claude') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      try {
        const { prompt } = JSON.parse(body);
        if (!prompt) {
          res.writeHead(400, CORS);
          res.end(JSON.stringify({ error: 'Prompt requerido' }));
          return;
        }
        if (!API_KEY) {
          res.writeHead(500, CORS);
          res.end(JSON.stringify({ error: 'API key no configurada' }));
          return;
        }

        const postData = JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 3000,
          messages: [{ role: 'user', content: prompt }]
        });

        const options = {
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Length': Buffer.byteLength(postData)
          }
        };

        const apiReq = https.request(options, (apiRes) => {
          let data = '';
          apiRes.on('data', chunk => data += chunk);
          apiRes.on('end', () => {
            if (apiRes.statusCode !== 200) {
              res.writeHead(apiRes.statusCode, CORS);
              res.end(JSON.stringify({ error: data }));
              return;
            }
            const parsed = JSON.parse(data);
            res.writeHead(200, CORS);
            res.end(JSON.stringify({ content: parsed.content }));
          });
        });

        apiReq.on('error', (e) => {
          res.writeHead(500, CORS);
          res.end(JSON.stringify({ error: e.message }));
        });

        apiReq.write(postData);
        apiReq.end();

      } catch(e) {
        res.writeHead(500, CORS);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404, CORS);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`Komebien backend running on port ${PORT}`);
});
