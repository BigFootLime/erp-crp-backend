-- Seed du modèle de rapport « Rapport de projet ERP CERP — Bac+5 » (16 parties, 64 sous-parties).
-- Donnée RÉFÉRENTIELLE du module (pas une donnée de test) : applicable cerp_test ET cerp_prod.
-- Idempotent : ON CONFLICT DO NOTHING partout ; ré-exécutable sans effet.
--   sudo -u postgres psql -d <db> -f db/seeds/project-office-report-template.sql

INSERT INTO public.project_report_templates (code, title, description, level, active)
VALUES (
  'RAPPORT_BAC5_CERP',
  'Rapport de projet ERP CERP — Bac+5',
  'Modèle en 16 étapes couvrant analyse du besoin, cadrage, spécifications, conception, développement, tests, déploiement et bilan. Chaque section est remplie à partir de preuves réelles (tâches, PR, tests, captures) — jamais de contenu inventé.',
  'BAC_PLUS_5',
  true
)
ON CONFLICT (code) DO NOTHING;

-- ------------------------------------------------------------------ 16 parties racines
WITH t AS (SELECT id FROM public.project_report_templates WHERE code = 'RAPPORT_BAC5_CERP'),
roots (section_number, title, description, ord) AS (VALUES
  ('1',  'Analyse du besoin et du contexte',
         'Comprendre le contexte du projet, son utilité et les attentes globales.', 10),
  ('2',  'Cadrage du projet',
         'Définir les bases du projet et ses objectifs principaux.', 20),
  ('3',  'Recueil des besoins utilisateurs',
         'Identifier précisément les besoins auxquels la solution devra répondre.', 30),
  ('4',  'Analyse des contraintes',
         'Identifier les limites du projet et les éléments susceptibles de l''impacter.', 40),
  ('5',  'Rédaction des spécifications',
         'Formaliser les besoins sous une forme exploitable pour le développement.', 50),
  ('6',  'Conception UX/UI',
         'Définir l''expérience utilisateur et les principes d''interface.', 60),
  ('7',  'Conception technique',
         'Définir l''architecture technique du projet.', 70),
  ('8',  'Planification du projet',
         'Organiser la réalisation du projet dans le temps.', 80),
  ('9',  'Mise en place de l''environnement',
         'Préparer les outils et environnements nécessaires au développement.', 90),
  ('10', 'Développement des fonctionnalités principales',
         'Réaliser le cœur fonctionnel du projet.', 100),
  ('11', 'Développement des fonctionnalités secondaires',
         'Compléter et enrichir la solution.', 110),
  ('12', 'Tests et validation technique',
         'Vérifier le bon fonctionnement de l''application.', 120),
  ('13', 'Optimisation et amélioration',
         'Améliorer la qualité et les performances du projet.', 130),
  ('14', 'Préparation au déploiement',
         'Préparer la mise en ligne ou la livraison du projet.', 140),
  ('15', 'Déploiement et démonstration',
         'Mettre le projet à disposition et le présenter.', 150),
  ('16', 'Documentation et bilan',
         'Clôturer le projet et formaliser les enseignements.', 160)
)
INSERT INTO public.project_report_sections (template_id, section_number, title, description, expected_content, display_order)
SELECT t.id, r.section_number, r.title, r.description, r.description, r.ord
FROM t, roots r
ON CONFLICT (template_id, section_number) DO NOTHING;

-- ------------------------------------------------------------------ 64 sous-parties
WITH t AS (SELECT id FROM public.project_report_templates WHERE code = 'RAPPORT_BAC5_CERP'),
subs (parent_number, section_number, title, ord) AS (VALUES
  ('1',  '1.1',  'Présentation du projet', 11),
  ('1',  '1.2',  'Identification du problème à résoudre', 12),
  ('1',  '1.3',  'Analyse des solutions existantes', 13),
  ('1',  '1.4',  'Identification des utilisateurs cibles', 14),
  ('2',  '2.1',  'Définition du projet', 21),
  ('2',  '2.2',  'Identification des parties prenantes', 22),
  ('2',  '2.3',  'Définition des objectifs fonctionnels', 23),
  ('2',  '2.4',  'Délimitation du périmètre', 24),
  ('3',  '3.1',  'Analyse des besoins utilisateurs', 31),
  ('3',  '3.2',  'Création de personas simples', 32),
  ('3',  '3.3',  'Définition des fonctionnalités principales', 33),
  ('3',  '3.4',  'Priorisation des besoins', 34),
  ('4',  '4.1',  'Contraintes techniques', 41),
  ('4',  '4.2',  'Contraintes de temps', 42),
  ('4',  '4.3',  'Contraintes de sécurité', 43),
  ('4',  '4.4',  'Contraintes liées à l''environnement', 44),
  ('5',  '5.1',  'Spécifications fonctionnelles', 51),
  ('5',  '5.2',  'Cas d''usage', 52),
  ('5',  '5.3',  'Critères d''acceptation', 53),
  ('5',  '5.4',  'Validation avec le tuteur ou l''encadrant', 54),
  ('6',  '6.1',  'Wireframes', 61),
  ('6',  '6.2',  'Parcours utilisateur', 62),
  ('6',  '6.3',  'Maquettes simples', 63),
  ('6',  '6.4',  'Validation des écrans', 64),
  ('7',  '7.1',  'Choix des technologies', 71),
  ('7',  '7.2',  'Architecture de l''application', 72),
  ('7',  '7.3',  'Modélisation de la base de données', 73),
  ('7',  '7.4',  'Définition des API', 74),
  ('8',  '8.1',  'Découpage en tâches', 81),
  ('8',  '8.2',  'Planning', 82),
  ('8',  '8.3',  'Priorisation', 83),
  ('8',  '8.4',  'Définition des livrables', 84),
  ('9',  '9.1',  'Installation des outils', 91),
  ('9',  '9.2',  'Configuration du projet', 92),
  ('9',  '9.3',  'Mise en place du versioning', 93),
  ('9',  '9.4',  'Configuration de la base de données', 94),
  ('10', '10.1', 'Développement des fonctionnalités principales', 101),
  ('10', '10.2', 'Respect des bonnes pratiques', 102),
  ('10', '10.3', 'Organisation du code', 103),
  ('10', '10.4', 'Tests simples', 104),
  ('11', '11.1', 'Ajout de fonctionnalités complémentaires', 111),
  ('11', '11.2', 'Amélioration UX', 112),
  ('11', '11.3', 'Gestion des erreurs', 113),
  ('11', '11.4', 'Sécurisation de base', 114),
  ('12', '12.1', 'Tests fonctionnels', 121),
  ('12', '12.2', 'Tests utilisateurs simples', 122),
  ('12', '12.3', 'Correction des bugs', 123),
  ('12', '12.4', 'Validation technique', 124),
  ('13', '13.1', 'Optimisation du code', 131),
  ('13', '13.2', 'Amélioration des performances', 132),
  ('13', '13.3', 'Nettoyage du code', 133),
  ('13', '13.4', 'Amélioration UX', 134),
  ('14', '14.1', 'Configuration serveur ou hébergement', 141),
  ('14', '14.2', 'Préparation de la base de données', 142),
  ('14', '14.3', 'Tests en conditions réelles', 143),
  ('14', '14.4', 'Vérification globale', 144),
  ('15', '15.1', 'Mise en ligne du projet', 151),
  ('15', '15.2', 'Vérification post-déploiement', 152),
  ('15', '15.3', 'Présentation du projet', 153),
  ('15', '15.4', 'Démonstration fonctionnelle', 154),
  ('16', '16.1', 'Documentation technique', 161),
  ('16', '16.2', 'Documentation utilisateur', 162),
  ('16', '16.3', 'Bilan du projet', 163),
  ('16', '16.4', 'Perspectives d''évolution', 164)
)
INSERT INTO public.project_report_sections (template_id, parent_id, section_number, title, display_order)
SELECT t.id, p.id, s.section_number, s.title, s.ord
FROM t
JOIN subs s ON true
JOIN public.project_report_sections p
  ON p.template_id = t.id AND p.section_number = s.parent_number
ON CONFLICT (template_id, section_number) DO NOTHING;
