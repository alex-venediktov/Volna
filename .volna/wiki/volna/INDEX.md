# Указатель раздела volna

Указатель разбит по этапам: превышен порог объёма. Этап открывает только свой файл.

Маршрут выбирается по колонкам «предмет», «тип» и «описание»: открывать нужно один узел,
а не раздел. Подходит несколько - открывать по одному, начиная с ближайшего к задаче.

| Куда | Вид | Предмет | Тип | Этапы | Описание |
|---|---|---|---|---|---|
| [analyze](INDEX--analyze.md) | узел · 5 | возврат к задаче, деление крупной работы, подсказка у поля ввода | ограничение ×2, договорённость, порядок | analyze, spec, plan, implement, capture, deliver, intake | - |
| [spec](INDEX--spec.md) | узел · 2 | деление крупной работы, остановы и вопросы | договорённость ×2 | analyze, spec, plan, deliver, close, intake | - |
| [plan](INDEX--plan.md) | узел · 10 | автопроход, длинная задача, где живёт состояние, деление крупной работы | ограничение ×5, порядок ×3, договорённость ×2 | analyze, spec, plan, implement, capture, deliver, close, intake | - |
| [implement](INDEX--implement.md) | узел · 14 | автопроход, длинная задача, возврат к задаче, возврат к этапу | порядок ×5, ограничение ×4, гейт ×2 | analyze, plan, implement, advocate, unit-tests, visual, capture, deliver, close, intake | - |
| [advocate](INDEX--advocate.md) | узел · 1 | возврат к этапу | порядок | implement, advocate, unit-tests, visual | - |
| [unit-tests](INDEX--unit-tests.md) | узел · 2 | возврат к этапу, обновление плагина | ограничение, порядок | implement, advocate, unit-tests, visual | - |
| [visual](INDEX--visual.md) | узел · 1 | возврат к этапу | порядок | implement, advocate, unit-tests, visual | - |
| [capture](INDEX--capture.md) | узел · 19 | автопроход, длинная задача, архивные журналы, возврат к задаче | порядок ×7, договорённость ×3, ограничение ×3 | analyze, plan, implement, capture, deliver, close, cleanup, intake | - |
| [deliver](INDEX--deliver.md) | узел · 6 | активная задача и гейт, ключи state.json, место этапа capture | договорённость ×2, побочный эффект ×2, ограничение | analyze, spec, plan, implement, capture, deliver, close, cleanup, intake | - |
| [close](INDEX--close.md) | узел · 3 | метки времени в журнале, остановы и вопросы, профиль проекта | договорённость ×3 | spec, plan, implement, capture, deliver, close, intake | - |
| [cleanup](INDEX--cleanup.md) | узел · 3 | активная задача и гейт, архивные журналы, изоляция плагина | договорённость, ограничение, побочный эффект | capture, deliver, cleanup, intake | - |
| [intake](INDEX--intake.md) | узел · 7 | профиль проекта, возврат к задаче, граница репозитория | договорённость ×2, гейт, ограничение | analyze, spec, plan, implement, capture, deliver, close, cleanup, intake | - |