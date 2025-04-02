"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.findUserByEmail = exports.createUser = void 0;
const database_1 = __importDefault(require("../../../config/database"));
const createUser = async (user, hashedPassword) => {
    const client = await database_1.default.connect();
    try {
        const { username, name, surname, email, tel_no, gender, address, lane, house_no, postcode, country = 'France', salary = 0, date_of_birth, role = 'Utilisateur', social_security_number } = user;
        const result = await client.query(`INSERT INTO users (
        username, password, name, surname, email, tel_no, gender, address,
        lane, house_no, postcode, country, salary, date_of_birth, role, social_security_number
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14, $15, $16
      ) RETURNING id, username, email, role;`, [
            username, hashedPassword, name, surname, email, tel_no, gender, address,
            lane, house_no, postcode, country, salary, date_of_birth, role, social_security_number
        ]);
        return result.rows[0];
    }
    finally {
        client.release();
    }
};
exports.createUser = createUser;
// 🔍 Cherche un utilisateur par email
const findUserByEmail = async (email) => {
    const client = await database_1.default.connect();
    try {
        const result = await client.query('SELECT * FROM users WHERE email = $1 LIMIT 1', [email]);
        return result.rows[0]; // undefined si pas trouvé
    }
    finally {
        client.release();
    }
};
exports.findUserByEmail = findUserByEmail;
