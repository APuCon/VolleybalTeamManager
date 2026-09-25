# Uitnodigingen

Een eigenaar kan vanuit het onderdeel **Teamleden** een uitnodiging vastleggen met het e-mailadres en de gewenste rol. De applicatie verstuurt bewust geen e-mail.

Stuur de coach daarom zelf via WhatsApp (of een ander kanaal) de volgende instructie:

1. Log in op de applicatie met hetzelfde e-mailadres als waarop de uitnodiging is vastgelegd.
2. Open daarna `https://<jouw-host>/.auth/login/aad?post_login_redirect_uri=/api/invitations/accept`.

Na het inloggen wordt de uitnodiging automatisch geaccepteerd, wordt de coach toegevoegd aan `VTMTeamMembers` en wordt de eenmalige uitnodiging verwijderd. Daarna wordt de coach teruggestuurd naar de applicatie. De rol Coach of Viewer uit de uitnodiging wordt overgenomen.
