# Moja Półka

Czytnik książek (PWA) z biblioteką, płynnym przewracaniem kartek, zakładkami i przypisami.
Działa w przeglądarce i po zainstalowaniu na telefonie – także bez internetu.

**Wersja na żywo:** https://bankowy11-lgtm.github.io/moja-polka/

## Co potrafi
- Półka z okładkami, „Czytaj dalej”, postęp w procentach.
- Przewracanie kartek palcem (kartka podąża za palcem) lub stuknięciem w prawą/lewą część ekranu.
- Dodawanie książek EPUB i TXT z telefonu (książki z DRM nie są obsługiwane).
- Wielkość liter, kolor strony (jasny / sepia / nocny), czcionka, odstęp linii.
- Spis treści, zakładki, przypisy w dymkach, suwak do przeskakiwania po książce.

## Pliki
- `index.html`, `style.css` – wygląd
- `js/app.js` – biblioteka
- `js/reader.js` – czytnik i przewracanie kartek
- `js/importer.js` – odczyt EPUB/TXT (z czyszczeniem treści)
- `js/db.js` – zapis książek w pamięci telefonu (IndexedDB)
- `sw.js` – praca bez internetu (po zmianach podbij `CACHE`)

## Książka startowa
„Tajemniczy ogród”, Frances Hodgson Burnett, tłum. Jadwiga Włodarkiewiczowa –
z [Wolnych Lektur](https://wolnelektury.pl/katalog/lektura/tajemniczy-ogrod/). Utwór w domenie publicznej;
przypisy redakcyjne na Licencji Wolnej Sztuki 1.3.
