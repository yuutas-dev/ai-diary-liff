begin;

alter table if exists public.favorite_writing_samples
  alter column source_entry_id type text using source_entry_id::text;

alter table if exists public.favorite_writing_samples
  alter column source_customer_id type text using source_customer_id::text;

commit;
