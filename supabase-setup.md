# Secure Message: Supabase Setup

This project remains a static HTML/CSS/JavaScript website. The browser encrypts a file first, then sends only the `.enc` ciphertext package to Supabase Storage. The original file and the secret key are never uploaded.

## 1. Create a project

1. Create a free project at https://supabase.com.
2. In **Project Settings > API**, copy the **Project URL** and the **anon public** key.
3. In `script.js`, replace the two empty values in `SUPABASE_CONFIG` with them.

The anon key is intended to be public in a browser application. Never put the `service_role` key in this project.

## 2. Create the storage bucket

1. Open **Storage** and create a bucket named `encrypted-packages`.
2. Keep it private. Files are downloaded through the application after metadata is selected.
3. Run this SQL in **SQL Editor**:

```sql
create table if not exists public.secure_messages (
  id uuid primary key,
  sender_name text not null default '익명',
  original_name text not null,
  package_size integer not null check (package_size > 0),
  storage_path text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.secure_messages enable row level security;

create policy "anyone can list active message metadata"
on public.secure_messages for select
using (expires_at > now());

create policy "anyone can create message metadata"
on public.secure_messages for insert
with check (expires_at > now());

create policy "anyone can upload encrypted packages"
on storage.objects for insert
with check (bucket_id = 'encrypted-packages');

create policy "anyone can download encrypted packages"
on storage.objects for select
using (bucket_id = 'encrypted-packages');
```

## Important classroom-demo note

The policies above intentionally allow public uploads and downloads for a small classroom demo. Anyone with the website URL can see the sender nickname, original filename, package size, and expiry time, and can download ciphertext. They cannot read the original without the separate secret key.

For a real service, add authentication, rate limiting, file scanning, private per-user access rules, and a server-side cleanup job. Expired metadata is hidden by the policy, but the associated Storage files should be deleted separately in the Supabase dashboard or with a scheduled Edge Function.
