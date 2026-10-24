# Gestor de Proyectos y PERT

Herramienta didáctica para planificar proyectos: diagrama de Gantt, red PERT, EDT, recursos,
costes, seguimiento e informes; un ejercicio de cálculo PERT (ES, EF, LS, LF y holgura) y un
editor de diagramas de flujo.

## Versión web

Sitio estático (sin compilación) publicado en Vercel. Para usarlo hay que iniciar sesión
(correo y contraseña, o Google) con Supabase Auth; los datos de cada usuario se guardan en la
tabla `app_data` de Supabase y se sincronizan entre ordenadores.

- `login.html`: inicio de sesión, registro y recuperación de contraseña.
- `js/supabase-config.js`: URL del proyecto y clave publicable.
- `js/cloud.js`: exige sesión y sincroniza con la nube las claves de `localStorage` de la app.

### Base de datos

```sql
create table public.app_data (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  key text not null check (char_length(key) <= 100),
  value text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);
alter table public.app_data enable row level security;
-- Políticas: cada usuario autenticado solo puede leer y escribir sus propias filas.
```

## Versión para Windows

`Gestor de Proyectos.exe` (o el `.zip`) funciona sin internet y guarda los datos en el propio
ordenador. Está hecha con Neutralino y usa las mismas páginas; en ella `cloud.js` no hace nada.
