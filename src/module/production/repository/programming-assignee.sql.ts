/** Same active-role eligibility for the picker and the assignment transaction. */
export const PROGRAMMING_ASSIGNEE_PREDICATE_SQL = `u.status='Active' AND EXISTS (
  SELECT 1 FROM public.app_roles r
  WHERE r.is_active AND lower(r.role_key) SIMILAR TO '%(admin|directeur|program|method|méthod|production)%'
    AND (r.role_key=u.role OR EXISTS (
      SELECT 1 FROM public.user_role_assignments a WHERE a.user_id=u.id AND a.role_key=r.role_key
    ))
)`;
