-- 0018_return_replacement_order.sql
-- H3.4: add replacement_order_id to return_requests so exchange resolution
-- can record which order was created for the exchanged variant(s).

begin;

alter table public.return_requests
  add column if not exists replacement_order_id uuid
    references public.orders(id) on delete set null;

comment on column public.return_requests.replacement_order_id is
  'Order created for exchange-action lines when the return is resolved as an exchange.';

commit;
