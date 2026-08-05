-- READ-ONLY. Recover the statements for the three staging migrations that have no committed file.
select version,
       name,
       array_length(statements, 1) as stmt_count,
       array_to_string(statements, E'\n;;;\n') as sql_text
  from supabase_migrations.schema_migrations
 where version in ('20260705210000','20260705220000','20260717120000')
 order by version;
