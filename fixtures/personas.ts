/** The five people in `ux/personas.md`. Addresses are `@example.com`. */
export interface Persona {
  key: string;
  id: string;
  name: string;
  email: string;
  /** `admin` puts a site user in `cms_identities`; `user` does not. */
  role: "admin" | "user";
  /** The raw CMS session cookie `persona-session --side cms` prints. */
  cmsSession: string;
}

export const PERSONAS: readonly Persona[] = [
  {
    key: "priya",
    id: "00000000-0000-4000-8000-000000000001",
    name: "Priya Shah",
    email: "priya@example.com",
    role: "admin",
    cmsSession: "00000000-0000-4000-9000-000000000001",
  },
  {
    key: "leo",
    id: "00000000-0000-4000-8000-000000000002",
    name: "Leo Marchetti",
    email: "leo@example.com",
    role: "admin",
    cmsSession: "00000000-0000-4000-9000-000000000002",
  },
  {
    key: "ade",
    id: "00000000-0000-4000-8000-000000000003",
    name: "Ade Mensah",
    email: "ade@example.com",
    role: "admin",
    cmsSession: "00000000-0000-4000-9000-000000000003",
  },
  {
    key: "zofia",
    id: "00000000-0000-4000-8000-000000000004",
    name: "Zofia Wiśniewska-Kowalczyk",
    email: "zofia.wisniewska-kowalczyk.design-studio@example.com",
    role: "admin",
    cmsSession: "00000000-0000-4000-9000-000000000004",
  },
  {
    key: "tom",
    id: "00000000-0000-4000-8000-000000000005",
    name: "Tom Okafor",
    email: "tom@example.com",
    role: "user",
    // Tom is not an editor, so no CMS session is ever issued for him.
    cmsSession: "",
  },
];

export const findPersona = (key: string): Persona | undefined =>
  PERSONAS.find((persona) => persona.key === key.toLowerCase());
