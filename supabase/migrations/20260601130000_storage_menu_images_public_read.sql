-- Allow public read of menu-images bucket (logos + menu item photos).
-- In Supabase Dashboard also set Storage > menu-images > Public bucket = ON.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'Public read menu-images'
  ) THEN
    CREATE POLICY "Public read menu-images"
      ON storage.objects
      FOR SELECT
      USING (bucket_id = 'menu-images');
  END IF;
END $$;
