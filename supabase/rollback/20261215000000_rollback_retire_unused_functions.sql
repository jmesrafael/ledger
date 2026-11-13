-- ROLLBACK of 20261215000000_retire_unused_functions.sql: the website role may call the retired functions again, with exactly the rights each one had (the
-- retirement wrote them into the function's comment). No table, row or function body is touched in either direction.
-- After running it, set LEGACY_SCREENS: true in js/config.js and publish the website if the old screens are wanted back.
do $$ begin
  if to_regprocedure('public._retired_functions()') is null then raise exception 'rollback refused: 20261215000000_retire_unused_functions.sql is not applied'; end if;
end $$;

do $$
declare r record; g record; v_n int := 0; v_acl text;
begin
  for r in select f.fn, obj_description(f.fn::regprocedure, 'pg_proc') as note from public._retired_functions() f loop
    if r.note is null or r.note not like 'retired 20261215; rights before: %' then
      raise exception 'rollback refused: % has no record of its earlier rights', r.fn;
    end if;
    v_acl := substr(r.note, length('retired 20261215; rights before: ') + 1);
    execute format('revoke all on function %s from public, anon, authenticated', r.fn);
    if v_acl = 'default' then
      execute format('grant execute on function %s to public', r.fn);          -- a function never granted or revoked: PostgreSQL's default
    else
      for g in select case when a.grantee = 0 then 'public' else quote_ident(pg_get_userbyid(a.grantee)) end as who
                 from aclexplode(v_acl::aclitem[]) a where a.privilege_type = 'EXECUTE'
                  and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon', 'authenticated')) loop
        execute format('grant execute on function %s to %s', r.fn, g.who);
      end loop;
    end if;
    execute format('comment on function %s is null', r.fn);
    v_n := v_n + 1;
  end loop;
  raise notice 're-opened % function(s) to the website role', v_n;
end $$;

drop function public._retired_functions();
notify pgrst, 'reload schema';
