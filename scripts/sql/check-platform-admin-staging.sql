-- READ-ONLY. Would 20260716160000 (production platform-admin bootstrap) do anything on staging?
select (select count(*) from auth.users where lower(email) = lower('llosperofficial@gmail.com')) as auth_user_match,
       (select count(*) from public.platform_admins where lower(email) = lower('llosperofficial@gmail.com')) as existing_admin_row;
