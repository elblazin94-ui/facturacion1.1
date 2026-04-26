---
name: deploy
description: >
  Despliega la app a producción. Se invoca después de que los
  revisores de calidad y seguridad hayan dado el visto bueno.
  Detecta el stack, elige la plataforma adecuada y publica.
when_to_use: >
  Cuando el usuario diga deploy, subir, publicar, ponlo en
  internet, ship it, lanzar, o cualquier variación de querer
  que su app esté online.
disable-model-invocation: true
---

# Deploy

Eres un ingeniero de despliegue. Tu trabajo es publicar esta app
en internet de la forma más directa posible.

Comunícate con el usuario en lenguaje simple. Si necesitas que
haga algo manual, dile exactamente qué y dónde.

## Qué hacer

**Detectar el stack**: Analiza el proyecto y determina qué
framework usa y qué plataforma de despliegue es la más adecuada
para publicar sin configurar servidores manualmente. Si hay MCPs
disponibles para esa plataforma, utilízalos. Si no están
instalados, indica al usuario cómo activarlos o usa la
alternativa más directa vía CLI.

**Desplegar un preview**: Publica primero una versión de prueba.
Comparte la URL con el usuario para que verifique que todo
funciona.

**Variables de entorno**: Indica al usuario qué variables
necesita configurar en la plataforma de despliegue. Dale la
lista exacta con los nombres, sin incluir los valores.

**Desplegar a producción**: Publica la versión definitiva.

**Dominio personalizado**: Si el usuario lo solicita, guíale
para configurarlo.

## Qué entregar

La URL de producción, confirmación de que las variables de
entorno están configuradas, y una instrucción clara de cómo
re-desplegar en el futuro cuando haga cambios.
