-- The Fase 1 automation-core schema (flows, flow_versions, flow_executions)
-- was created with RLS policies for dashboard users (`authenticated`) but
-- never granted access to `service_role`, so the admin API could not read or
-- write it yet. This only adds the missing grants; no schema changes.
grant select, insert, update on table public.flows to service_role;
grant select, insert, update on table public.flow_versions to service_role;
grant insert on table public.flow_executions to service_role;
