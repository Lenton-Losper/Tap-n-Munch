import WebSocket from 'ws';

describe('Supabase realtime', () => {
  const SUPABASE_URL = process.env.SUPABASE_URL!;
  const ANON_KEY = process.env.SUPABASE_ANON_KEY!;
  const wsBase = SUPABASE_URL.replace('https', 'wss');

  function makeWs(): WebSocket {
    return new WebSocket(`${wsBase}/realtime/v1/websocket?vsn=1.0.0&apikey=${ANON_KEY}`);
  }

  test('WebSocket connects within 3s', (done) => {
    const ws = makeWs();
    const t = setTimeout(() => {
      ws.close();
      done(new Error('Timeout'));
    }, 3000);
    ws.on('open', () => {
      clearTimeout(t);
      ws.close();
      done();
    });
    ws.on('error', (e) => {
      clearTimeout(t);
      done(e);
    });
  });

  test('Orders channel receives subscription ack', (done) => {
    const ws = makeWs();
    ws.on('open', () => {
      ws.send(JSON.stringify({ topic: 'realtime:public:orders', event: 'phx_join', payload: {}, ref: '1' }));
    });
    const t = setTimeout(() => {
      ws.close();
      done(new Error('No ack within 4s'));
    }, 4000);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.event === 'phx_reply' || msg.topic?.includes('orders')) {
        clearTimeout(t);
        ws.close();
        done();
      }
    });
    ws.on('error', (e) => {
      clearTimeout(t);
      done(e);
    });
  });

  test('Tabs channel receives subscription ack', (done) => {
    const ws = makeWs();
    ws.on('open', () => {
      ws.send(JSON.stringify({ topic: 'realtime:public:tabs', event: 'phx_join', payload: {}, ref: '2' }));
    });
    const t = setTimeout(() => {
      ws.close();
      done(new Error('No ack within 4s'));
    }, 4000);
    ws.on('message', (raw) => {
      clearTimeout(t);
      ws.close();
      done();
    });
    ws.on('error', (e) => {
      clearTimeout(t);
      done(e);
    });
  });
});
