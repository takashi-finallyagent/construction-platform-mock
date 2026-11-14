CREATE FUNCTION public.lock_membership(target_company uuid) RETURNS TABLE (role text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
  SELECT m.role FROM public.memberships m
  WHERE m.company_id = target_company
    AND m.user_id = current_setting('app.user_id', true) AND m.active
  FOR SHARE;
$$;
REVOKE ALL ON FUNCTION public.lock_membership(uuid) FROM PUBLIC;
