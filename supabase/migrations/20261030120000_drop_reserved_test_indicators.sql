-- Test fixtures never belong in live findings. Removes from
-- threat_ioc_telemetry every indicator that can only be a test value: names
-- under the reserved TLDs (.example, .test, .invalid, .localhost) and
-- example.com/.net/.org (RFC 2606 / RFC 6761), the documentation IP ranges
-- (RFC 5737, RFC 3849), CVE-0000-* ids and PG1's fixture wallets
-- (lib/fixtures.mjs). Same rule as isReservedTestIndicator in
-- lib/sourcePolicy.mjs, which also keeps them out of every read.
-- Guarded: does nothing where the table does not exist.

do $$
begin
  if to_regclass('public.threat_ioc_telemetry') is null then
    return;
  end if;
  delete from public.threat_ioc_telemetry
  where lower(btrim(value)) ~ '^([a-z][a-z0-9+.-]*://)?([^/?#@]*@)?([a-z0-9-]+\.)*(example|test|invalid|localhost)\.?(:[0-9]+)?([/?#].*)?$'
     or lower(btrim(value)) ~ '^([a-z][a-z0-9+.-]*://)?([^/?#@]*@)?([a-z0-9-]+\.)*example\.(com|net|org)\.?(:[0-9]+)?([/?#].*)?$'
     or btrim(value) ~ '^(192\.0\.2|198\.51\.100|203\.0\.113)\.[0-9]{1,3}$'
     or lower(btrim(value)) like '2001:db8:%'
     or lower(btrim(value)) like '2001:0db8:%'
     or lower(btrim(value)) like 'cve-0000-%'
     or lower(btrim(value)) like '0x7067312d746573742d66697874757265%';
end $$;
