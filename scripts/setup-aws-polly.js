#!/usr/bin/env node

const fs = require('fs');
const { PollyClient, DescribeVoicesCommand } = require('@aws-sdk/client-polly');

async function setupAWSPolly() {
  console.log('🎙️ PG1.Agent - AWS Polly FREE Voice Setup');

  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const region = validateRegion(process.env.AWS_REGION || 'us-east-1');

  if (!accessKeyId || !secretAccessKey) {
    console.error('❌ AWS credentials missing in environment');
    console.log('Set these environment variables before running setup:');
    console.log('  AWS_ACCESS_KEY_ID=your_key');
    console.log('  AWS_SECRET_ACCESS_KEY=your_secret');
    console.log('  AWS_REGION=us-east-1');
    process.exit(1);
  }

  const polly = new PollyClient({
    region,
    credentials: { accessKeyId, secretAccessKey }
  });

  try {
    const result = await polly.send(new DescribeVoicesCommand({}));
    console.log('✅ Connected to AWS Polly');
    console.log(`✅ Available voices: ${result.Voices.length}`);
    console.log('✅ Free tier: 5M chars/month');
  } catch (error) {
    console.error('❌ Failed to connect to Polly:', error.message);
    process.exit(1);
  }

  function validateRegion(region) {
    const safeRegion = String(region || '').trim();
    const regionPattern = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
    if (!regionPattern.test(safeRegion)) {
      console.error('❌ Invalid AWS region format');
      process.exit(1);
    }
    return safeRegion;
  }

  const envContent = `AWS_ACCESS_KEY_ID=${accessKeyId}
AWS_SECRET_ACCESS_KEY=${secretAccessKey}
AWS_REGION=${region}
PG1_VOICE_PROVIDER=amazon-polly
PG1_DEFAULT_VOICE=Joanna
PG1_VOICE_FORMAT=mp3
PG1_VOICE_RATE=22050
PG1_VOICE_CACHE_ENABLED=true
PG1_VOICE_CACHE_DIR=./cache/voices
`;

  fs.writeFileSync('.env.voice', envContent, 'utf8');
  fs.mkdirSync('./cache/voices', { recursive: true });

  console.log('✅ Voice configuration saved to .env.voice');
  console.log('⚠️ Keep .env.voice private. It contains AWS credentials and must never be committed or shared.');
  console.log('✅ Voice cache directory created');
  console.log('\n✅ AWS Polly setup complete');
}

setupAWSPolly().catch((error) => {
  console.error('Setup failed:', error);
  process.exit(1);
});
