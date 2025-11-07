const https = require('https');
require('dotenv').config({ path: '.env.local' });

const apiKey = process.env.OPENAI_API_KEY;

// Test 1: Check if we can access the models endpoint
const options = {
  hostname: 'api.openai.com',
  path: '/v1/models',
  method: 'GET',
  headers: {
    'Authorization': `Bearer ${apiKey}`,
  }
};

console.log('Testing API Key access...\n');

https.get(options, (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    if (res.statusCode === 200) {
      const models = JSON.parse(data);
      const realtimeModels = models.data.filter(m => m.id.includes('realtime'));

      console.log('✅ API Key is valid!');
      console.log(`\nRealtime models available (${realtimeModels.length}):`);
      realtimeModels.forEach(m => console.log(`  - ${m.id}`));

      if (realtimeModels.length === 0) {
        console.log('\n⚠️  WARNING: No realtime models found!');
        console.log('Your API key may not have access to the Realtime API.');
        console.log('You may need to:');
        console.log('  1. Upgrade your OpenAI account');
        console.log('  2. Enable Realtime API access');
        console.log('  3. Check your billing settings');
      }
    } else {
      console.log(`❌ API Error (${res.statusCode})`);
      console.log(data);
    }
  });
}).on('error', (err) => {
  console.error('❌ Request failed:', err.message);
});
