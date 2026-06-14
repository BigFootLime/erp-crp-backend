-- 20260612_cnc_machine_intelligence.sql
-- CNC machine intelligence model.
--
-- The existing public.machines table remains the physical machine instance table
-- because production, planning, pointage and quality records already reference it.
-- This patch adds normalized machine model/spec/capability/tooling/document data
-- around that stable instance spine.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.production_machine_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_code text NOT NULL,
  manufacturer text NOT NULL,
  model text NOT NULL,
  display_name text NOT NULL,
  machine_type public.machine_type NOT NULL DEFAULT 'OTHER',
  axes_count integer NULL CHECK (axes_count IS NULL OR axes_count > 0),
  description text NULL,
  source_summary text NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT production_machine_models_code_key UNIQUE (model_code),
  CONSTRAINT production_machine_models_manufacturer_model_key UNIQUE (manufacturer, model)
);

CREATE TABLE IF NOT EXISTS public.production_machine_specs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_model_id uuid NOT NULL REFERENCES public.production_machine_models(id) ON DELETE CASCADE,

  x_travel_mm numeric(10, 3) NULL,
  y_travel_mm numeric(10, 3) NULL,
  z_travel_mm numeric(10, 3) NULL,
  table_length_mm numeric(10, 3) NULL,
  table_width_mm numeric(10, 3) NULL,
  max_table_load_kg numeric(10, 3) NULL,
  max_workpiece_length_mm numeric(10, 3) NULL,
  max_workpiece_width_mm numeric(10, 3) NULL,
  max_workpiece_height_mm numeric(10, 3) NULL,
  machining_envelope_notes text NULL,
  rotary_table_info text NULL,

  spindle_taper text NULL,
  spindle_speed_max_rpm integer NULL CHECK (spindle_speed_max_rpm IS NULL OR spindle_speed_max_rpm > 0),
  spindle_power_kw numeric(10, 3) NULL,
  spindle_torque_nm numeric(10, 3) NULL,
  spindle_motor_specs text NULL,
  through_spindle_coolant boolean NULL,
  coolant_pressure_bar numeric(10, 3) NULL,

  tool_magazine_capacity integer NULL CHECK (tool_magazine_capacity IS NULL OR tool_magazine_capacity > 0),
  max_tool_diameter_mm numeric(10, 3) NULL,
  max_tool_length_mm numeric(10, 3) NULL,
  max_tool_weight_kg numeric(10, 3) NULL,
  tool_change_time_sec numeric(10, 3) NULL,
  compatible_holders text[] NOT NULL DEFAULT '{}',

  rapid_traverse_x_m_min numeric(10, 3) NULL,
  rapid_traverse_y_m_min numeric(10, 3) NULL,
  rapid_traverse_z_m_min numeric(10, 3) NULL,
  cutting_feed_max_m_min numeric(10, 3) NULL,
  acceleration_notes text NULL,
  positioning_accuracy_mm numeric(10, 5) NULL,
  repeatability_mm numeric(10, 5) NULL,

  cnc_control text NULL,
  control_features text[] NOT NULL DEFAULT '{}',
  communication_interfaces text[] NOT NULL DEFAULT '{}',
  program_format_notes text NULL,

  machine_footprint_length_mm numeric(10, 3) NULL,
  machine_footprint_width_mm numeric(10, 3) NULL,
  machine_height_mm numeric(10, 3) NULL,
  machine_weight_kg numeric(10, 3) NULL,
  required_air_pressure_bar numeric(10, 3) NULL,
  power_requirement_kva numeric(10, 3) NULL,
  coolant_tank_capacity_l numeric(10, 3) NULL,
  chip_conveyor_notes text NULL,

  operations_notes text NULL,
  maintenance_notes text NULL,

  source_url text NULL,
  source_type text NOT NULL DEFAULT 'unknown',
  source_confidence text NOT NULL DEFAULT 'unknown',
  source_notes text NULL,
  raw_spec jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT production_machine_specs_model_unique UNIQUE (machine_model_id),
  CONSTRAINT production_machine_specs_source_confidence_ck CHECK (
    source_confidence IN ('official', 'resale_listing', 'estimated', 'internal', 'unknown')
  ),
  CONSTRAINT production_machine_specs_source_type_ck CHECK (
    source_type IN ('manufacturer_page', 'manufacturer_pdf', 'resale_listing', 'internal_note', 'mixed', 'unknown')
  )
);

CREATE TABLE IF NOT EXISTS public.production_machine_capabilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_model_id uuid NOT NULL REFERENCES public.production_machine_models(id) ON DELETE CASCADE,
  process_type text NOT NULL,
  material_family text NULL,
  capability_level text NOT NULL DEFAULT 'supported',
  notes text NULL,
  source_url text NULL,
  source_confidence text NOT NULL DEFAULT 'unknown',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT production_machine_capabilities_level_ck CHECK (
    capability_level IN ('preferred', 'primary', 'supported', 'limited', 'unknown')
  ),
  CONSTRAINT production_machine_capabilities_source_confidence_ck CHECK (
    source_confidence IN ('official', 'resale_listing', 'estimated', 'internal', 'unknown')
  )
);

CREATE TABLE IF NOT EXISTS public.production_machine_tooling (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_model_id uuid NOT NULL REFERENCES public.production_machine_models(id) ON DELETE CASCADE,
  holder_type text NOT NULL,
  spindle_taper text NULL,
  tool_family text NULL,
  outillage_family_id integer NULL,
  compatible boolean NOT NULL DEFAULT true,
  notes text NULL,
  source_url text NULL,
  source_confidence text NOT NULL DEFAULT 'unknown',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT production_machine_tooling_source_confidence_ck CHECK (
    source_confidence IN ('official', 'resale_listing', 'estimated', 'internal', 'unknown')
  )
);

CREATE TABLE IF NOT EXISTS public.production_machine_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_model_id uuid NULL REFERENCES public.production_machine_models(id) ON DELETE CASCADE,
  machine_id uuid NULL REFERENCES public.machines(id) ON DELETE CASCADE,
  title text NOT NULL,
  document_type text NOT NULL,
  url text NULL,
  storage_path text NULL,
  source_type text NOT NULL DEFAULT 'unknown',
  source_confidence text NOT NULL DEFAULT 'unknown',
  source_notes text NULL,
  retrieved_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT production_machine_documents_owner_ck CHECK (machine_model_id IS NOT NULL OR machine_id IS NOT NULL),
  CONSTRAINT production_machine_documents_type_ck CHECK (
    document_type IN ('OFFICIAL_PAGE', 'BROCHURE_PDF', 'MANUAL', 'IMAGE', 'RESALE_LISTING', 'INTERNAL_NOTE')
  ),
  CONSTRAINT production_machine_documents_source_confidence_ck CHECK (
    source_confidence IN ('official', 'resale_listing', 'estimated', 'internal', 'unknown')
  ),
  CONSTRAINT production_machine_documents_source_type_ck CHECK (
    source_type IN ('manufacturer_page', 'manufacturer_pdf', 'resale_listing', 'internal_note', 'mixed', 'unknown')
  )
);

ALTER TABLE public.machines
  ADD COLUMN IF NOT EXISTS machine_model_id uuid NULL,
  ADD COLUMN IF NOT EXISTS display_name text NULL,
  ADD COLUMN IF NOT EXISTS dashboard_color text NULL,
  ADD COLUMN IF NOT EXISTS model_3d_path text NULL,
  ADD COLUMN IF NOT EXISTS documentation_url text NULL,
  ADD COLUMN IF NOT EXISTS documentation_source text NULL,
  ADD COLUMN IF NOT EXISTS commissioned_year integer NULL,
  ADD COLUMN IF NOT EXISTS scheduling_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS outillage_enabled boolean NOT NULL DEFAULT true;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'machines_machine_model_id_fkey'
      AND conrelid = 'public.machines'::regclass
  ) THEN
    ALTER TABLE public.machines
      ADD CONSTRAINT machines_machine_model_id_fkey
      FOREIGN KEY (machine_model_id)
      REFERENCES public.production_machine_models(id)
      ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'machines_commissioned_year_ck'
      AND conrelid = 'public.machines'::regclass
  ) THEN
    ALTER TABLE public.machines
      ADD CONSTRAINT machines_commissioned_year_ck
      CHECK (commissioned_year IS NULL OR commissioned_year BETWEEN 1970 AND 2100);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_machines_machine_model_id
  ON public.machines(machine_model_id);

CREATE INDEX IF NOT EXISTS idx_machines_scheduling_enabled
  ON public.machines(scheduling_enabled);

CREATE INDEX IF NOT EXISTS idx_machines_outillage_enabled
  ON public.machines(outillage_enabled);

CREATE INDEX IF NOT EXISTS idx_production_machine_models_type
  ON public.production_machine_models(machine_type);

CREATE INDEX IF NOT EXISTS idx_production_machine_specs_model
  ON public.production_machine_specs(machine_model_id);

CREATE INDEX IF NOT EXISTS idx_production_machine_capabilities_model
  ON public.production_machine_capabilities(machine_model_id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_production_machine_capabilities_model_process_material
  ON public.production_machine_capabilities(machine_model_id, process_type, (COALESCE(material_family, '')));

CREATE INDEX IF NOT EXISTS idx_production_machine_tooling_model
  ON public.production_machine_tooling(machine_model_id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_production_machine_tooling_model_holder_family
  ON public.production_machine_tooling(machine_model_id, holder_type, (COALESCE(tool_family, '')));

CREATE INDEX IF NOT EXISTS idx_production_machine_documents_model
  ON public.production_machine_documents(machine_model_id);

CREATE INDEX IF NOT EXISTS idx_production_machine_documents_machine
  ON public.production_machine_documents(machine_id);

-- Trigger updated_at where the shared helper exists.
DO $$
BEGIN
  IF to_regproc('public.tg_set_updated_at()') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS production_machine_models_set_updated_at ON public.production_machine_models';
    EXECUTE 'CREATE TRIGGER production_machine_models_set_updated_at BEFORE UPDATE ON public.production_machine_models FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';

    EXECUTE 'DROP TRIGGER IF EXISTS production_machine_specs_set_updated_at ON public.production_machine_specs';
    EXECUTE 'CREATE TRIGGER production_machine_specs_set_updated_at BEFORE UPDATE ON public.production_machine_specs FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';

    EXECUTE 'DROP TRIGGER IF EXISTS production_machine_capabilities_set_updated_at ON public.production_machine_capabilities';
    EXECUTE 'CREATE TRIGGER production_machine_capabilities_set_updated_at BEFORE UPDATE ON public.production_machine_capabilities FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';

    EXECUTE 'DROP TRIGGER IF EXISTS production_machine_tooling_set_updated_at ON public.production_machine_tooling';
    EXECUTE 'CREATE TRIGGER production_machine_tooling_set_updated_at BEFORE UPDATE ON public.production_machine_tooling FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';
  END IF;
END $$;

WITH model_seed AS (
  SELECT *
  FROM (VALUES
    ('HURCO-VM10', 'Hurco', 'VM10', 'Hurco VM10', 'MILLING'::public.machine_type, 3, 'Centre d''usinage vertical 3 axes compact, pilotage Hurco WinMax selon configuration.', 'Official Hurco VM10 page.'),
    ('MATSUURA-VX1000', 'Matsuura', 'VX-1000', 'Matsuura VX-1000', 'MILLING'::public.machine_type, 3, 'Centre d''usinage vertical 3 axes VX Series.', 'Official Matsuura / Matsuura USA VX documentation.'),
    ('MATSUURA-VX660', 'Matsuura', 'VX-660', 'Matsuura VX-660', 'MILLING'::public.machine_type, 3, 'Centre d''usinage vertical 3 axes VX Series.', 'Official Matsuura / Matsuura USA VX documentation.'),
    ('TAKUMI-VC1052', 'Takumi', 'VC1052', 'Takumi VC1052', 'MILLING'::public.machine_type, 3, 'Centre d''usinage vertical 3 axes a table croisee.', 'Official Takumi France / Takumi USA / brochure data.'),
    ('DMG-DMC63V', 'DMG', 'DMC 63V', 'DMG DMC 63V', 'MILLING'::public.machine_type, 3, 'Centre d''usinage vertical 3 axes Deckel Maho / DMG.', 'Resale listings and broker technical sheets; verify against internal manual/nameplate.'),
    ('DMG-DMC635VECO', 'DMG', 'DMC 635 V eco', 'DMG DMC 635 V eco', 'MILLING'::public.machine_type, 3, 'Centre d''usinage vertical 3 axes DMC V eco / ecoline.', 'DMG brochure snippets plus resale listings; verify exact workshop unit options.'),
    ('NOMURA-DST40L', 'Nomura DS', 'DST-40L', 'Nomura DS DST-40L', 'MILLING'::public.machine_type, 3, 'Centre compact de percage/taraudage grande vitesse.', 'Official Nomura DS DST-40L page.')
  ) AS v(model_code, manufacturer, model, display_name, machine_type, axes_count, description, source_summary)
)
INSERT INTO public.production_machine_models (
  model_code,
  manufacturer,
  model,
  display_name,
  machine_type,
  axes_count,
  description,
  source_summary
)
SELECT model_code, manufacturer, model, display_name, machine_type, axes_count, description, source_summary
FROM model_seed
ON CONFLICT (model_code) DO UPDATE
SET
  manufacturer = EXCLUDED.manufacturer,
  model = EXCLUDED.model,
  display_name = EXCLUDED.display_name,
  machine_type = EXCLUDED.machine_type,
  axes_count = EXCLUDED.axes_count,
  description = EXCLUDED.description,
  source_summary = EXCLUDED.source_summary,
  updated_at = now();

WITH specs AS (
  SELECT *
  FROM (VALUES
    (
      'HURCO-VM10', 661::numeric, 407::numeric, 508::numeric, 762::numeric, 406::numeric, 1500::numeric,
      NULL::numeric, NULL::numeric, NULL::numeric, 'Vertical 3-axis machining envelope; verify table load on the exact CRP units because older VM10 brochures list lower loads.', 'No rotary table in base source.',
      'CAT 40', 12000, 11::numeric, 72.4::numeric, '11 kW / 15 hp spindle; 72.4 Nm listed by current official Hurco page.', NULL::boolean, NULL::numeric,
      24, 80::numeric, 250::numeric, 7::numeric, 2::numeric, ARRAY['CAT 40'],
      NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::text, NULL::numeric, NULL::numeric,
      'Hurco WinMax / Hurco control family', ARRAY['Conversational programming', 'NC/G-code programming'], ARRAY[]::text[], 'Hurco conversational and conventional NC formats supported by Hurco controls.',
      NULL::numeric, NULL::numeric, NULL::numeric, 3230::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::text,
      'General milling, drilling and tapping on small/medium prismatic parts.', 'Use internal Hurco maintenance manual for lubrication and service intervals.',
      'https://www.hurco.com/products/3-axis-machining-centers/vm/vm10', 'manufacturer_page', 'official', 'Official Hurco VM10 page; table load should be verified against machine plates.'
    ),
    (
      'MATSUURA-VX1000', 1020::numeric, 610::numeric, 610::numeric, 1200::numeric, 600::numeric, 500::numeric,
      NULL::numeric, NULL::numeric, NULL::numeric, 'X/Y/Z 1020/610/610 mm, table 1200 x 600 mm.', 'No rotary table in base source.',
      'BT40', 15000, 15::numeric, 150::numeric, 'Matsuura VX spindle; AC 15/22 kW low speed values listed in manufacturer release/brochure.', true, 20::numeric,
      30, 76::numeric, 300::numeric, 7::numeric, NULL::numeric, ARRAY['BT40', 'JIS B 6339 40T', '40P pull stud'],
      40::numeric, 40::numeric, 36::numeric, NULL::numeric, NULL::text, NULL::numeric, NULL::numeric,
      'Fanuc 31i / G-Tech31i depending year/options', ARRAY['Spindle thermal displacement compensation'], ARRAY[]::text[], NULL::text,
      NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, 'Lift-up scraper conveyor and right/left spiral chip conveyors listed as standard in Matsuura release.',
      'Milling from aluminium to cast iron and titanium per Matsuura brochure language.', 'Use internal Matsuura manual for service intervals.',
      'https://www.matsuura.co.jp/english/pdf/2012/VX-1000_1500.pdf', 'manufacturer_pdf', 'official', 'Official release plus VX brochure. Optional 48/60 magazine and 20,000 rpm spindle exist; seed stores standard spec.'
    ),
    (
      'MATSUURA-VX660', 660::numeric, 550::numeric, 560::numeric, 940::numeric, 550::numeric, 500::numeric,
      NULL::numeric, NULL::numeric, NULL::numeric, 'X/Y/Z 660/550/560 mm, table 940 x 550 mm.', 'No rotary table in base source.',
      'BT40', 15000, 12::numeric, NULL::numeric, 'BT40 15,000 min-1 standard; 20,000 min-1 option.', true, 20::numeric,
      30, 76::numeric, 300::numeric, 7::numeric, NULL::numeric, ARRAY['BT40', 'JIS B 6339 40T', '40P pull stud'],
      48::numeric, 48::numeric, 48::numeric, 48::numeric, NULL::text, NULL::numeric, NULL::numeric,
      'G-Tech31i / Fanuc family depending market', ARRAY[]::text[], ARRAY[]::text[], NULL::text,
      NULL::numeric, NULL::numeric, NULL::numeric, 5615::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::text,
      'Compact 3-axis vertical machining for general materials.', 'Use internal Matsuura manual for service intervals.',
      'https://www.matsuurausa.com/wp-content/uploads/VX-660-OG0-OG0-E1.0-201709-3000-E-E.pdf', 'manufacturer_pdf', 'official', 'Official Matsuura USA brochure. Optional spindle/magazine variants exist.'
    ),
    (
      'TAKUMI-VC1052', 1060::numeric, 520::numeric, 610::numeric, 1160::numeric, 520::numeric, 650::numeric,
      NULL::numeric, NULL::numeric, NULL::numeric, 'X/Y/Z 1060/520/610 mm, table 1160 x 520 mm.', 'No rotary table in base source.',
      'SA40 BigPlus / BBT40', 15000, 14::numeric, 89.4::numeric, 'French page lists 10-14 kW; Takumi USA lists 15 kW; seed keeps conservative French nominal.', NULL::boolean, 30::numeric,
      30, 80::numeric, 300::numeric, 7::numeric, NULL::numeric, ARRAY['SA40 BigPlus', 'BBT40', 'CAT 40'],
      36::numeric, 36::numeric, 24::numeric, 12::numeric, NULL::text, NULL::numeric, NULL::numeric,
      'Heidenhain TNC 640', ARRAY['Dialog programming', 'ISO NC programming', 'Touch probe cycles'], ARRAY['Ethernet', 'USB', 'RS-232-C', 'RS-422'], 'Heidenhain Klartext and ISO NC programming per TNC 640 documentation.',
      NULL::numeric, NULL::numeric, NULL::numeric, 5900::numeric, NULL::numeric, 30::numeric, NULL::numeric, 'Chip management and spindle chiller standard in brochure sources.',
      'General milling, mold machining, drilling and tapping.', 'Use internal Takumi manual for service intervals.',
      'https://takumicnc.fr/centres-usinage-cnc-3-axes-table-croisee/vc1052/', 'manufacturer_page', 'official', 'Official Takumi France page plus Takumi USA/brochure for detailed ATC and system data.'
    ),
    (
      'DMG-DMC63V', 630::numeric, 500::numeric, 500::numeric, 800::numeric, 500::numeric, 500::numeric,
      NULL::numeric, NULL::numeric, NULL::numeric, 'Typical DMC 63V listing data: 630/500/500 mm travels, 800 x 500 mm table.', 'No rotary table in base CRP assumption; several used units may have options.',
      'SK40 / ISO40', 8000, 13::numeric, 83::numeric, 'Common resale/broker values: 13 kW / 83 Nm; exact workshop unit must be checked.', NULL::boolean, NULL::numeric,
      24, 80::numeric, 300::numeric, 10::numeric, NULL::numeric, ARRAY['SK40', 'ISO40'],
      30::numeric, 30::numeric, 30::numeric, 10::numeric, NULL::text, 0.010::numeric, NULL::numeric,
      'Siemens 810D / Heidenhain TNC variants', ARRAY[]::text[], ARRAY[]::text[], NULL::text,
      3100::numeric, 2100::numeric, 2400::numeric, 4500::numeric, NULL::numeric, 30::numeric, NULL::numeric, 'Coolant tank/chip conveyor vary by used unit.',
      'General 3-axis vertical milling, drilling and tapping.', 'Use internal DMG/Deckel Maho manual and nameplate for maintenance intervals.',
      'https://www.exapro.com/sp/dmg-dmc63v-703/', 'resale_listing', 'resale_listing', 'Resale listing family; Exapro contains one likely erroneous max part weight value, so table load is taken from corroborating broker listings.'
    ),
    (
      'DMG-DMC635VECO', 635::numeric, 510::numeric, 460::numeric, 790::numeric, 560::numeric, 600::numeric,
      NULL::numeric, NULL::numeric, NULL::numeric, 'DMC 635 V eco work area 635/510/460 mm, table 790 x 560 mm.', 'No rotary table in base source; some used units list rotary options.',
      'SK40 / ISO40', 8000, 13::numeric, 83::numeric, 'DMC V eco brochure lists 13/9 kW and 83/57 Nm; 12,000 rpm and 30-pocket options exist.', NULL::boolean, 3.7::numeric,
      20, 80::numeric, 300::numeric, 6::numeric, 1.6::numeric, ARRAY['SK40', 'ISO40'],
      30::numeric, 30::numeric, 30::numeric, 20::numeric, NULL::text, NULL::numeric, NULL::numeric,
      'Siemens 810D / Heidenhain TNC / Fanuc variants', ARRAY['ShopMill / 3D simulation on Siemens-equipped units'], ARRAY[]::text[], NULL::text,
      2530::numeric, 2050::numeric, 2650::numeric, 4500::numeric, NULL::numeric, NULL::numeric, NULL::numeric, 'Chip conveyor and coolant vary by used unit.',
      'General 3-axis vertical milling, drilling and tapping.', 'Use internal DMG manual and nameplate for maintenance intervals.',
      'https://www.exapro.com/sp/dmg-dmc635veco-721/', 'mixed', 'resale_listing', 'DMG brochure snippets plus Exapro/resale listings; exact CRP unit options must be checked.'
    ),
    (
      'NOMURA-DST40L', 720.09::numeric, 400.05::numeric, 350.01::numeric, 850.14::numeric, 400.05::numeric, NULL::numeric,
      NULL::numeric, NULL::numeric, NULL::numeric, 'DST-40L table 33.47 x 15.75 in; travel 28.35 x 15.75 x 13.78 in converted to mm.', 'No rotary table in base source.',
      'BBT30 face contact', 15000, 7.46::numeric, NULL::numeric, 'Official page shows 15,000 rpm plus 24,000 option and product copy mentions 30,000 rpm; verify exact spindle option.', NULL::boolean, NULL::numeric,
      21, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, ARRAY['BBT30'],
      60::numeric, 60::numeric, 60::numeric, NULL::numeric, NULL::text, NULL::numeric, NULL::numeric,
      'Mitsubishi M80', ARRAY[]::text[], ARRAY[]::text[], NULL::text,
      2151.38::numeric, 2080.26::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::text,
      'High-speed drilling, tapping and light/medium milling on compact parts.', 'Use internal Nomura DS manual for service intervals.',
      'https://nomura-ds.com/machines/dst-40l', 'manufacturer_page', 'official', 'Official page lists 15,000 rpm plus 24,000 option while overview copy mentions 30,000 rpm; store 15,000 as standard max.'
    )
  ) AS v(
    model_code, x_travel_mm, y_travel_mm, z_travel_mm, table_length_mm, table_width_mm, max_table_load_kg,
    max_workpiece_length_mm, max_workpiece_width_mm, max_workpiece_height_mm, machining_envelope_notes, rotary_table_info,
    spindle_taper, spindle_speed_max_rpm, spindle_power_kw, spindle_torque_nm, spindle_motor_specs, through_spindle_coolant, coolant_pressure_bar,
    tool_magazine_capacity, max_tool_diameter_mm, max_tool_length_mm, max_tool_weight_kg, tool_change_time_sec, compatible_holders,
    rapid_traverse_x_m_min, rapid_traverse_y_m_min, rapid_traverse_z_m_min, cutting_feed_max_m_min, acceleration_notes, positioning_accuracy_mm, repeatability_mm,
    cnc_control, control_features, communication_interfaces, program_format_notes,
    machine_footprint_length_mm, machine_footprint_width_mm, machine_height_mm, machine_weight_kg, required_air_pressure_bar, power_requirement_kva, coolant_tank_capacity_l, chip_conveyor_notes,
    operations_notes, maintenance_notes, source_url, source_type, source_confidence, source_notes
  )
)
INSERT INTO public.production_machine_specs (
  machine_model_id,
  x_travel_mm, y_travel_mm, z_travel_mm, table_length_mm, table_width_mm, max_table_load_kg,
  max_workpiece_length_mm, max_workpiece_width_mm, max_workpiece_height_mm, machining_envelope_notes, rotary_table_info,
  spindle_taper, spindle_speed_max_rpm, spindle_power_kw, spindle_torque_nm, spindle_motor_specs, through_spindle_coolant, coolant_pressure_bar,
  tool_magazine_capacity, max_tool_diameter_mm, max_tool_length_mm, max_tool_weight_kg, tool_change_time_sec, compatible_holders,
  rapid_traverse_x_m_min, rapid_traverse_y_m_min, rapid_traverse_z_m_min, cutting_feed_max_m_min, acceleration_notes, positioning_accuracy_mm, repeatability_mm,
  cnc_control, control_features, communication_interfaces, program_format_notes,
  machine_footprint_length_mm, machine_footprint_width_mm, machine_height_mm, machine_weight_kg, required_air_pressure_bar, power_requirement_kva, coolant_tank_capacity_l, chip_conveyor_notes,
  operations_notes, maintenance_notes, source_url, source_type, source_confidence, source_notes
)
SELECT
  m.id,
  s.x_travel_mm, s.y_travel_mm, s.z_travel_mm, s.table_length_mm, s.table_width_mm, s.max_table_load_kg,
  s.max_workpiece_length_mm, s.max_workpiece_width_mm, s.max_workpiece_height_mm, s.machining_envelope_notes, s.rotary_table_info,
  s.spindle_taper, s.spindle_speed_max_rpm, s.spindle_power_kw, s.spindle_torque_nm, s.spindle_motor_specs, s.through_spindle_coolant, s.coolant_pressure_bar,
  s.tool_magazine_capacity, s.max_tool_diameter_mm, s.max_tool_length_mm, s.max_tool_weight_kg, s.tool_change_time_sec, s.compatible_holders,
  s.rapid_traverse_x_m_min, s.rapid_traverse_y_m_min, s.rapid_traverse_z_m_min, s.cutting_feed_max_m_min, s.acceleration_notes, s.positioning_accuracy_mm, s.repeatability_mm,
  s.cnc_control, s.control_features, s.communication_interfaces, s.program_format_notes,
  s.machine_footprint_length_mm, s.machine_footprint_width_mm, s.machine_height_mm, s.machine_weight_kg, s.required_air_pressure_bar, s.power_requirement_kva, s.coolant_tank_capacity_l, s.chip_conveyor_notes,
  s.operations_notes, s.maintenance_notes, s.source_url, s.source_type, s.source_confidence, s.source_notes
FROM specs s
JOIN public.production_machine_models m ON m.model_code = s.model_code
ON CONFLICT (machine_model_id) DO UPDATE
SET
  x_travel_mm = EXCLUDED.x_travel_mm,
  y_travel_mm = EXCLUDED.y_travel_mm,
  z_travel_mm = EXCLUDED.z_travel_mm,
  table_length_mm = EXCLUDED.table_length_mm,
  table_width_mm = EXCLUDED.table_width_mm,
  max_table_load_kg = EXCLUDED.max_table_load_kg,
  machining_envelope_notes = EXCLUDED.machining_envelope_notes,
  rotary_table_info = EXCLUDED.rotary_table_info,
  spindle_taper = EXCLUDED.spindle_taper,
  spindle_speed_max_rpm = EXCLUDED.spindle_speed_max_rpm,
  spindle_power_kw = EXCLUDED.spindle_power_kw,
  spindle_torque_nm = EXCLUDED.spindle_torque_nm,
  spindle_motor_specs = EXCLUDED.spindle_motor_specs,
  through_spindle_coolant = EXCLUDED.through_spindle_coolant,
  coolant_pressure_bar = EXCLUDED.coolant_pressure_bar,
  tool_magazine_capacity = EXCLUDED.tool_magazine_capacity,
  max_tool_diameter_mm = EXCLUDED.max_tool_diameter_mm,
  max_tool_length_mm = EXCLUDED.max_tool_length_mm,
  max_tool_weight_kg = EXCLUDED.max_tool_weight_kg,
  tool_change_time_sec = EXCLUDED.tool_change_time_sec,
  compatible_holders = EXCLUDED.compatible_holders,
  rapid_traverse_x_m_min = EXCLUDED.rapid_traverse_x_m_min,
  rapid_traverse_y_m_min = EXCLUDED.rapid_traverse_y_m_min,
  rapid_traverse_z_m_min = EXCLUDED.rapid_traverse_z_m_min,
  cutting_feed_max_m_min = EXCLUDED.cutting_feed_max_m_min,
  positioning_accuracy_mm = EXCLUDED.positioning_accuracy_mm,
  repeatability_mm = EXCLUDED.repeatability_mm,
  cnc_control = EXCLUDED.cnc_control,
  control_features = EXCLUDED.control_features,
  communication_interfaces = EXCLUDED.communication_interfaces,
  program_format_notes = EXCLUDED.program_format_notes,
  machine_footprint_length_mm = EXCLUDED.machine_footprint_length_mm,
  machine_footprint_width_mm = EXCLUDED.machine_footprint_width_mm,
  machine_height_mm = EXCLUDED.machine_height_mm,
  machine_weight_kg = EXCLUDED.machine_weight_kg,
  required_air_pressure_bar = EXCLUDED.required_air_pressure_bar,
  power_requirement_kva = EXCLUDED.power_requirement_kva,
  coolant_tank_capacity_l = EXCLUDED.coolant_tank_capacity_l,
  chip_conveyor_notes = EXCLUDED.chip_conveyor_notes,
  operations_notes = EXCLUDED.operations_notes,
  maintenance_notes = EXCLUDED.maintenance_notes,
  source_url = EXCLUDED.source_url,
  source_type = EXCLUDED.source_type,
  source_confidence = EXCLUDED.source_confidence,
  source_notes = EXCLUDED.source_notes,
  updated_at = now();

WITH capability_seed AS (
  SELECT *
  FROM (VALUES
    ('HURCO-VM10', 'milling', 'aluminium', 'primary', 'Compact 3-axis milling.'),
    ('HURCO-VM10', 'drilling', NULL, 'supported', 'Supported by VMC configuration.'),
    ('HURCO-VM10', 'tapping', NULL, 'supported', 'Supported by Hurco VMC controls/options.'),
    ('MATSUURA-VX1000', 'milling', 'aluminium', 'primary', 'Manufacturer brochure explicitly references aluminium.'),
    ('MATSUURA-VX1000', 'milling', 'cast iron', 'supported', 'Manufacturer brochure explicitly references cast iron.'),
    ('MATSUURA-VX1000', 'milling', 'titanium', 'supported', 'Manufacturer brochure explicitly references titanium.'),
    ('MATSUURA-VX660', 'milling', 'aluminium', 'primary', 'Compact VX machining center.'),
    ('MATSUURA-VX660', 'drilling', NULL, 'supported', 'Supported by VMC configuration.'),
    ('TAKUMI-VC1052', 'milling', 'mold steel', 'primary', 'Brochure sources position VC1052 for mold machining.'),
    ('TAKUMI-VC1052', 'drilling', NULL, 'supported', 'Supported by VMC configuration.'),
    ('DMG-DMC63V', 'milling', NULL, 'supported', 'Resale/broker data; verify exact CRP unit.'),
    ('DMG-DMC63V', 'drilling', NULL, 'supported', 'Resale/broker data; verify exact CRP unit.'),
    ('DMG-DMC635VECO', 'milling', NULL, 'supported', 'DMC V eco 3-axis vertical milling.'),
    ('DMG-DMC635VECO', 'drilling', NULL, 'supported', 'Supported by VMC configuration.'),
    ('NOMURA-DST40L', 'tapping', NULL, 'primary', 'Official Nomura page identifies the DST-40L as high-speed tapping center.'),
    ('NOMURA-DST40L', 'drilling', NULL, 'primary', 'Compact machining center for drilling/tapping work.'),
    ('NOMURA-DST40L', 'milling', 'light alloys', 'supported', 'Light/medium compact milling inferred from DST compact machining center positioning.')
  ) AS v(model_code, process_type, material_family, capability_level, notes)
)
INSERT INTO public.production_machine_capabilities (
  machine_model_id,
  process_type,
  material_family,
  capability_level,
  notes,
  source_confidence
)
SELECT
  m.id,
  c.process_type,
  c.material_family,
  c.capability_level,
  c.notes,
  CASE WHEN c.model_code LIKE 'DMG-%' THEN 'resale_listing' ELSE 'official' END
FROM capability_seed c
JOIN public.production_machine_models m ON m.model_code = c.model_code
ON CONFLICT (machine_model_id, process_type, (COALESCE(material_family, ''))) DO UPDATE
SET
  capability_level = EXCLUDED.capability_level,
  notes = EXCLUDED.notes,
  source_confidence = EXCLUDED.source_confidence,
  updated_at = now();

WITH tooling_seed AS (
  SELECT *
  FROM (VALUES
    ('HURCO-VM10', 'CAT 40', 'CAT 40', 'fraisage/perçage/taraudage', 'Official Hurco VM10 holder family.'),
    ('MATSUURA-VX1000', 'BT40', 'BT40', 'fraisage/perçage/taraudage', 'Standard VX-1000 spindle taper.'),
    ('MATSUURA-VX660', 'BT40', 'BT40', 'fraisage/perçage/taraudage', 'Standard VX-660 spindle taper.'),
    ('TAKUMI-VC1052', 'SA40 BigPlus', 'SA40 BigPlus / BBT40', 'fraisage/perçage/taraudage', 'Takumi France lists SA40 BigPlus / BBT40.'),
    ('TAKUMI-VC1052', 'BBT40', 'SA40 BigPlus / BBT40', 'fraisage/perçage/taraudage', 'Takumi France lists SA40 BigPlus / BBT40.'),
    ('DMG-DMC63V', 'SK40', 'SK40 / ISO40', 'fraisage/perçage/taraudage', 'Resale listings; verify exact taper on CRP unit.'),
    ('DMG-DMC635VECO', 'SK40', 'SK40 / ISO40', 'fraisage/perçage/taraudage', 'Resale listings; verify exact taper on CRP unit.'),
    ('NOMURA-DST40L', 'BBT30', 'BBT30 face contact', 'perçage/taraudage/fraisage léger', 'Official Nomura DST-40L taper.')
  ) AS v(model_code, holder_type, spindle_taper, tool_family, notes)
)
INSERT INTO public.production_machine_tooling (
  machine_model_id,
  holder_type,
  spindle_taper,
  tool_family,
  notes,
  source_confidence
)
SELECT
  m.id,
  t.holder_type,
  t.spindle_taper,
  t.tool_family,
  t.notes,
  CASE WHEN t.model_code LIKE 'DMG-%' THEN 'resale_listing' ELSE 'official' END
FROM tooling_seed t
JOIN public.production_machine_models m ON m.model_code = t.model_code
ON CONFLICT (machine_model_id, holder_type, (COALESCE(tool_family, ''))) DO UPDATE
SET
  spindle_taper = EXCLUDED.spindle_taper,
  notes = EXCLUDED.notes,
  source_confidence = EXCLUDED.source_confidence,
  updated_at = now();

WITH document_seed AS (
  SELECT *
  FROM (VALUES
    ('HURCO-VM10', 'Hurco VM10 official specifications', 'OFFICIAL_PAGE', 'https://www.hurco.com/products/3-axis-machining-centers/vm/vm10', 'manufacturer_page', 'official', 'Official manufacturer page.'),
    ('MATSUURA-VX1000', 'Matsuura VX-1000 official page', 'OFFICIAL_PAGE', 'https://www.matsuura.co.jp/english/products/vx-series/vx-1000', 'manufacturer_page', 'official', 'Official manufacturer page.'),
    ('MATSUURA-VX1000', 'Matsuura VX-1000 / VX-1500 release PDF', 'BROCHURE_PDF', 'https://www.matsuura.co.jp/english/pdf/2012/VX-1000_1500.pdf', 'manufacturer_pdf', 'official', 'Official manufacturer PDF release/specification.'),
    ('MATSUURA-VX660', 'Matsuura VX-660 official page', 'OFFICIAL_PAGE', 'https://www.matsuura.co.jp/english/products/vx-series/vx-660', 'manufacturer_page', 'official', 'Official manufacturer page.'),
    ('MATSUURA-VX660', 'Matsuura VX-660 brochure PDF', 'BROCHURE_PDF', 'https://www.matsuurausa.com/wp-content/uploads/VX-660-OG0-OG0-E1.0-201709-3000-E-E.pdf', 'manufacturer_pdf', 'official', 'Official Matsuura USA brochure PDF.'),
    ('TAKUMI-VC1052', 'Takumi France VC1052 official page', 'OFFICIAL_PAGE', 'https://takumicnc.fr/centres-usinage-cnc-3-axes-table-croisee/vc1052/', 'manufacturer_page', 'official', 'Official Takumi France page.'),
    ('DMG-DMC63V', 'DMG DMC 63V Exapro listing family', 'RESALE_LISTING', 'https://www.exapro.com/sp/dmg-dmc63v-703/', 'resale_listing', 'resale_listing', 'Used-machine listing family; verify CRP unit.'),
    ('DMG-DMC635VECO', 'DMG DMC 635 V eco Exapro listing family', 'RESALE_LISTING', 'https://www.exapro.com/sp/dmg-dmc635veco-721/', 'resale_listing', 'resale_listing', 'Used-machine listing family; verify CRP unit.'),
    ('NOMURA-DST40L', 'Nomura DS DST-40L official page', 'OFFICIAL_PAGE', 'https://nomura-ds.com/machines/dst-40l', 'manufacturer_page', 'official', 'Official manufacturer page.')
  ) AS v(model_code, title, document_type, url, source_type, source_confidence, source_notes)
)
INSERT INTO public.production_machine_documents (
  machine_model_id,
  title,
  document_type,
  url,
  source_type,
  source_confidence,
  source_notes
)
SELECT
  m.id,
  d.title,
  d.document_type,
  d.url,
  d.source_type,
  d.source_confidence,
  d.source_notes
FROM document_seed d
JOIN public.production_machine_models m ON m.model_code = d.model_code
WHERE NOT EXISTS (
  SELECT 1
  FROM public.production_machine_documents existing
  WHERE existing.machine_model_id = m.id
    AND existing.url = d.url
);

WITH instance_seed AS (
  SELECT *
  FROM (VALUES
    ('VM10-01', 'Hurco VM10 01', 'HURCO-VM10', 'VM10 01', '#2563EB', '/models/machines/cnc-01.glb'),
    ('VM10-02', 'Hurco VM10 02', 'HURCO-VM10', 'VM10 02', '#2563EB', '/models/machines/cnc-01.glb'),
    ('VX1000-01', 'Matsuura VX-1000 01', 'MATSUURA-VX1000', 'VX-1000 01', '#0F766E', '/models/machines/cnc-01.glb'),
    ('VX1000-02', 'Matsuura VX-1000 02', 'MATSUURA-VX1000', 'VX-1000 02', '#0F766E', '/models/machines/cnc-01.glb'),
    ('TAKUMI1052-01', 'Takumi VC1052 01', 'TAKUMI-VC1052', 'Takumi 1052 01', '#0E7490', '/models/machines/cnc-01.glb'),
    ('TAKUMI1052-02', 'Takumi VC1052 02', 'TAKUMI-VC1052', 'Takumi 1052 02', '#0E7490', '/models/machines/cnc-01.glb'),
    ('VX660-01', 'Matsuura VX-660 01', 'MATSUURA-VX660', 'VX-660 01', '#0F766E', '/models/machines/cnc-01.glb'),
    ('NOMURA-DST40L-01', 'Nomura DS DST-40L 01', 'NOMURA-DST40L', 'DST-40L 01', '#B45309', '/models/machines/cnc-01.glb'),
    ('DMC63V-01', 'DMG DMC 63V 01', 'DMG-DMC63V', 'DMC 63V 01', '#6D28D9', '/models/machines/cnc-01.glb'),
    ('DMC635VECO-01', 'DMG DMC 635 V eco 01', 'DMG-DMC635VECO', 'DMC 635 V eco 01', '#6D28D9', '/models/machines/cnc-01.glb')
  ) AS v(code, name, model_code, display_name, dashboard_color, model_3d_path)
)
INSERT INTO public.machines (
  code,
  name,
  type,
  brand,
  model,
  machine_model_id,
  display_name,
  dashboard_color,
  model_3d_path,
  documentation_url,
  documentation_source,
  hourly_rate,
  currency,
  status,
  is_available,
  scheduling_enabled,
  outillage_enabled,
  notes
)
SELECT
  i.code,
  i.name,
  m.machine_type,
  m.manufacturer,
  m.model,
  m.id,
  i.display_name,
  i.dashboard_color,
  i.model_3d_path,
  s.source_url,
  s.source_confidence,
  0,
  'EUR',
  'ACTIVE'::public.machine_status,
  true,
  true,
  true,
  'Seed CNC workshop instance. Serial number, commissioning year and exact location must be filled from internal workshop records.'
FROM instance_seed i
JOIN public.production_machine_models m ON m.model_code = i.model_code
LEFT JOIN public.production_machine_specs s ON s.machine_model_id = m.id
ON CONFLICT (code) DO UPDATE
SET
  machine_model_id = EXCLUDED.machine_model_id,
  brand = EXCLUDED.brand,
  model = EXCLUDED.model,
  display_name = EXCLUDED.display_name,
  dashboard_color = EXCLUDED.dashboard_color,
  model_3d_path = EXCLUDED.model_3d_path,
  documentation_url = EXCLUDED.documentation_url,
  documentation_source = EXCLUDED.documentation_source,
  scheduling_enabled = EXCLUDED.scheduling_enabled,
  outillage_enabled = EXCLUDED.outillage_enabled,
  updated_at = now();

COMMENT ON TABLE public.production_machine_models IS 'Normalized CNC machine model catalog. Physical instances remain in public.machines.';
COMMENT ON TABLE public.production_machine_specs IS 'Technical machine specifications used for capacity, feasibility, planning and machine fiches.';
COMMENT ON TABLE public.production_machine_capabilities IS 'Process/material capabilities for machine models.';
COMMENT ON TABLE public.production_machine_tooling IS 'Tool holder and tooling family compatibility for machine models.';
COMMENT ON TABLE public.production_machine_documents IS 'Machine model and instance documentation sources with confidence tracking.';
COMMENT ON COLUMN public.machines.machine_model_id IS 'Optional link from physical machine instance to normalized production_machine_models.';
COMMENT ON COLUMN public.machines.scheduling_enabled IS 'Whether this physical machine can be used by scheduling/planning logic.';
COMMENT ON COLUMN public.machines.outillage_enabled IS 'Whether this physical machine participates in outillage compatibility workflows.';

COMMIT;
