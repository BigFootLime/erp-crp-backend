import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { CreateUserDTO } from '../types/user.type';
import { createUser } from '../repository/auth.repository';
import { findUserByUsername } from '../repository/auth.repository';
import { ApiError } from "../../../utils/apiError";
import { insertLoginLog } from "../repository/authLog.repository";

export const registerUser = async (data: CreateUserDTO) => {
  // 🔐 Hash du mot de passe
  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(data.password, salt);

  // 📤 Enregistrement en base
  const user = await createUser(data, hashedPassword);
  return user;
};

export const loginUser = async (
  username: string,
  password: string,
  meta: {
    ip: string | null;
    user_agent: string | null;
    device_type: string | null;
    os: string | null;
    browser: string | null;
  }
) => {
  const normalizedUsername = username.trim().toUpperCase();

  const user = await findUserByUsername(normalizedUsername);

  // Toujours message générique (sécurité)
  const invalidMsg = "Identifiants invalides";

  if (!user) {
    await insertLoginLog({
      user_id: null,
      username_attempt: normalizedUsername,
      success: false,
      failure_reason: "USER_NOT_FOUND",
      ...meta,
    });
    throw new ApiError(401, "AUTH_INVALID", invalidMsg);
  }

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    await insertLoginLog({
      user_id: user.id,
      username_attempt: normalizedUsername,
      success: false,
      failure_reason: "BAD_PASSWORD",
      ...meta,
    });
    throw new ApiError(401, "AUTH_INVALID", invalidMsg);
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, email: user.email, role: user.role },
    process.env.JWT_SECRET as string,
    { expiresIn: "1d" }
  );

  await insertLoginLog({
    user_id: user.id,
    username_attempt: normalizedUsername,
    success: true,
    failure_reason: null,
    ...meta,
  });

  return {
    token,
    user: { id: user.id, username: user.username, email: user.email, role: user.role },
  };
};
