# Указатель раздела volna

Указатель разбит по этапам: превышен порог объёма. Этап открывает только свой файл.

Маршрут выбирается по колонкам «предмет», «тип» и «описание»: открывать нужно один узел,
а не раздел. Подходит несколько - открывать по одному, начиная с ближайшего к задаче.

| Куда | Вид | Предмет | Тип | Этапы | Описание |
|---|---|---|---|---|---|
| [analyze](INDEX--analyze.md) | узел · 4 | возврат к задаче, подсказка у поля ввода, поиск маршрута по указателю | ограничение ×2, порядок, термин | analyze, plan, implement, deliver, capture, intake | - |
| [spec](INDEX--spec.md) | узел · 1 | остановы и вопросы | договорённость | spec, deliver, close, intake | - |
| [plan](INDEX--plan.md) | узел · 8 | автопроход, длинная задача, оси дробления указателя, подсказка у поля ввода | ограничение ×4, порядок ×3, договорённость | analyze, plan, implement, deliver, close, capture, intake | - |
| [advocate](INDEX--advocate.md) | узел · 1 | возврат к этапу | порядок | advocate, implement, unit-tests, visual | - |
| [implement](INDEX--implement.md) | узел · 9 | автопроход, длинная задача, возврат к задаче, возврат к этапу | ограничение ×3, порядок ×3, гейт | analyze, plan, advocate, implement, unit-tests, visual, deliver, close, capture, intake | - |
| [unit-tests](INDEX--unit-tests.md) | узел · 2 | возврат к этапу, обновление плагина | ограничение, порядок | advocate, implement, unit-tests, visual | - |
| [visual](INDEX--visual.md) | узел · 1 | возврат к этапу | порядок | advocate, implement, unit-tests, visual | - |
| [deliver](INDEX--deliver.md) | узел · 3 | остановы и вопросы, подсказка у поля ввода, профиль проекта | договорённость ×2, ограничение | analyze, spec, plan, implement, deliver, close, intake | - |
| [close](INDEX--close.md) | узел · 3 | метки времени в журнале, остановы и вопросы, профиль проекта | договорённость ×3 | spec, plan, implement, deliver, close, capture, intake | - |
| [cleanup](INDEX--cleanup.md) | узел · 2 | архивные журналы, изоляция плагина | договорённость, ограничение | cleanup, capture, intake | - |
| [capture](INDEX--capture.md) | узел · 13 | автопроход, длинная задача, архивные журналы, возврат к задаче | порядок ×4, договорённость ×3, ограничение ×2 | analyze, plan, implement, close, cleanup, capture, intake | - |
| [intake](INDEX--intake.md) | узел · 6 | профиль проекта, возврат к задаче, граница репозитория | договорённость ×2, гейт, ограничение | analyze, spec, plan, implement, deliver, close, cleanup, capture, intake | - |