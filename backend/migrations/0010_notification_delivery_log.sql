-- 0010_notification_delivery_log.sql
-- Delivery log for notification provider webhook dispatches.
-- Separate from webhook_delivery_log (which is for integration webhooks with FK to integration_webhooks).

create table if not exists public.notification_delivery_log (
  id               uuid        primary key default gen_random_uuid(),
  provider_id      uuid        not null references public.notification_providers(id) on delete cascade,
  store_id         uuid        not null references public.stores(id) on delete cascade,
  event            text        not null,
  payload          jsonb       not null default '{}',
  attempt_number   int         not null default 1,
  status_code      int,
  response_body    text,
  error_message    text,
  duration_ms      int,
  delivered_at     timestamptz not null default now()
);
comment on table public.notification_delivery_log is
  'Per-attempt delivery log for notification provider webhook dispatches.';
create index idx_notif_delivery_provider on public.notification_delivery_log(provider_id, delivered_at desc);
create index idx_notif_delivery_store    on public.notification_delivery_log(store_id, event, delivered_at desc);
create index idx_notif_delivery_failed   on public.notification_delivery_log(provider_id)
  where status_code is null or status_code >= 400;

-- Retention trigger: keep last 90 days
create or replace function public.notification_delivery_log_retention()
returns trigger language plpgsql as $$
begin
  delete from public.notification_delivery_log
  where delivered_at < now() - interval '90 days';
  return null;
end;
$$;

drop trigger if exists trg_notif_delivery_retention on public.notification_delivery_log;
create trigger trg_notif_delivery_retention
  after insert on public.notification_delivery_log
  for each row execute function public.notification_delivery_log_retention();
