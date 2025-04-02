/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: Authentification et sécurité
 */

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: Connexion utilisateur
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Connexion réussie
 *       401:
 *         description: Identifiants invalides
 */

/**
 * @swagger
 * /auth/register:
 *   post:
 *     summary: Créer un utilisateur
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Register'
 *     responses:
 *       201:
 *         description: Utilisateur créé
 *       400:
 *         description: Erreur de validation
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     Register:
 *       type: object
 *       required:
 *         - username
 *         - password
 *         - email
 *         - name
 *         - surname
 *         - tel_no
 *         - gender
 *         - address
 *         - lane
 *         - house_no
 *         - postcode
 *         - country
 *         - salary
 *         - date_of_birth
 *         - role
 *         - social_security_number
 *       properties:
 *         username:
 *           type: string
 *         password:
 *           type: string
 *         email:
 *           type: string
 *         name:
 *           type: string
 *         surname:
 *           type: string
 *         tel_no:
 *           type: string
 *         gender:
 *           type: string
 *         address:
 *           type: string
 *         lane:
 *           type: string
 *         house_no:
 *           type: string
 *         postcode:
 *           type: string
 *         country:
 *           type: string
 *         salary:
 *           type: number
 *         date_of_birth:
 *           type: string
 *         role:
 *           type: string
 *         social_security_number:
 *           type: string
 */
