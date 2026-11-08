-- Protected permissions (users.manage_admins, roles.assign, roles.edit_permissions, settings.manage)
-- may only be held by SUPER_ADMIN. Enforced in the database so no application bug can grant them
-- to another role (docs/ROLE_PERMISSION_MATRIX.md, "Super Admin safeguards").

CREATE FUNCTION "enforce_protected_permissions"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "permissions" p, "roles" r
    WHERE p."id" = NEW."permission_id"
      AND r."id" = NEW."role_id"
      AND p."is_protected"
      AND r."key" <> 'SUPER_ADMIN'
  ) THEN
    RAISE EXCEPTION 'protected permission can only be granted to SUPER_ADMIN' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "role_permissions_protected" BEFORE INSERT OR UPDATE ON "role_permissions"
  FOR EACH ROW EXECUTE FUNCTION "enforce_protected_permissions"();

-- A permission already held by another role cannot later be marked protected.
CREATE FUNCTION "enforce_protected_flag"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."is_protected" AND EXISTS (
    SELECT 1
    FROM "role_permissions" rp JOIN "roles" r ON r."id" = rp."role_id"
    WHERE rp."permission_id" = NEW."id" AND r."key" <> 'SUPER_ADMIN'
  ) THEN
    RAISE EXCEPTION 'permission is held by a non-SUPER_ADMIN role and cannot be protected' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "permissions_protected_flag" BEFORE UPDATE OF "is_protected" ON "permissions"
  FOR EACH ROW EXECUTE FUNCTION "enforce_protected_flag"();
