export interface GradeResult {
  name: string;
  pass: boolean;
  detail?: string;
}

export const grade = (name: string, pass: boolean, detail?: string): GradeResult => ({ name, pass, detail });
