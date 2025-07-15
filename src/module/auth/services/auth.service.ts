import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { CreateUserDTO } from '../types/user.type';
import { createUser } from '../repository/auth.repository';
import { findUserByUsername } from '../repository/auth.repository';

export const registerUser = async (data: CreateUserDTO) => {
  // 🔐 Hash du mot de passe
  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(data.password, salt);

  // 📤 Enregistrement en base
  const user = await createUser(data, hashedPassword);
  return user;
};

export const loginUser = async (username: string, password: string) => {
  const user = await findUserByUsername(username);

  if (!user) {
    throw new Error("Email ou mot de passe incorrect");
  }

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    throw new Error("Email ou mot de passe incorrect");
  }

  // 🔐 Génération du JWT
  const token = jwt.sign(
    {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
    },
    process.env.JWT_SECRET as string,
    { expiresIn: '1d' }
  );

  return {
    token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
    },
  };
};
