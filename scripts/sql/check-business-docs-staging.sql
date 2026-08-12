-- READ-ONLY. How much of 20260705280000_business_documents is already present on staging?
select 'tables' as kind,
       string_agg(table_name, ', ' order by table_name) as present
  from information_schema.tables
 where table_schema = 'public'
   and table_name in ('restaurant_billing_profiles','document_sequences','business_documents')
union all
select 'policies',
       string_agg(policyname, ' | ' order by policyname)
  from pg_policies
 where schemaname = 'public'
   and tablename in ('restaurant_billing_profiles','document_sequences','business_documents')
union all
select 'indexes',
       string_agg(indexname, ', ' order by indexname)
  from pg_indexes
 where schemaname = 'public'
   and indexname in ('restaurant_billing_profiles_restaurant_id_idx','business_documents_restaurant_id_idx','business_documents_restaurant_id_document_type_idx','business_documents_quote_id_idx');
