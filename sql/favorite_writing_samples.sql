create table if not exists public.favorite_writing_samples (
  id bigserial primary key,
  user_id text not null,
  source_entry_id bigint not null,
  source_customer_id bigint null,
  source_customer_name text null,
  sample_text text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists favorite_writing_samples_user_entry_uidx
  on public.favorite_writing_samples (user_id, source_entry_id);

create index if not exists favorite_writing_samples_user_id_idx
  on public.favorite_writing_samples (user_id, created_at desc);
