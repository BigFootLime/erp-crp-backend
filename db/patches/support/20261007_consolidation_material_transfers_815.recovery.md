# Recovery — #815

Save the database before applying the additive patch. Retain the previous backend
release and restore its service pointer if compilation or startup fails. The table
can remain installed with the previous code; it does not rewrite existing holds.

Once a regrouping uses this table, preserve the provenance rows. Dissolve a still
unstarted regrouping through the API to return original holds to their source OFs.
Any consumed quantity or additional active hold prevents dissolution. Restore from
backup only as an explicitly approved incident procedure, never erase traceability.
