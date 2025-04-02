export interface CreateUserDTO {
    username: string;
    password: string;
    name: string;
    surname: string;
    email: string;
    tel_no: string;
    gender: string;
    address: string;
    lane: string;
    house_no: string;
    postcode: string;
    country?: string;
    salary?: number;
    date_of_birth: string;
    role?: string;
    social_security_number: string;
  }
  