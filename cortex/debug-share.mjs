import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

// Parse .env.local manually
const envText = readFileSync('.env.local', 'utf-8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim();
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

console.log('URL configured:', !!url);
console.log('Key type:', process.env.SUPABASE_SERVICE_ROLE_KEY ? 'service_role' : 'anon');

const sb = createClient(url, key, { auth: { persistSession: false } });

// Check if share_slug column exists
const { data, error } = await sb
  .from('documents')
  .select('id, title, share_slug')
  .not('share_slug', 'is', null)
  .limit(5);

if (error) {
  console.log('ERROR querying share_slug:', error.message, error.code, error.hint);
} else {
  console.log('Docs with share_slug:', data?.length ?? 0);
  if (data) data.forEach(d => console.log('  -', d.title, '→', d.share_slug));
}

// Total docs
const { count } = await sb.from('documents').select('id', { count: 'exact', head: true });
console.log('Total documents:', count);

// Try RLS check - query with anon key too
if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
  const anonSb = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data: anonData, error: anonErr } = await anonSb
    .from('documents')
    .select('id, title, share_slug')
    .not('share_slug', 'is', null)
    .limit(5);
  if (anonErr) {
    console.log('ANON key error:', anonErr.message);
  } else {
    console.log('Anon key sees:', anonData?.length ?? 0, 'shared docs');
  }
}

process.exit(0);
