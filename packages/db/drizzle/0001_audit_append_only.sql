-- audit_log is append-only. UPDATE is always rejected. DELETE is rejected unless the
-- delete-everything job sets `SET LOCAL hub.allow_audit_delete = 'on'` in its transaction.
CREATE OR REPLACE FUNCTION audit_log_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'audit_log is append-only';
  END IF;
  IF TG_OP = 'DELETE' AND coalesce(current_setting('hub.allow_audit_delete', true), '') <> 'on' THEN
    RAISE EXCEPTION 'audit_log rows can only be deleted by the delete-everything job';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_guard();
