# Скелет харнеса захвата снимка

> Этот файл — **источник правды** для временного харнеса. В рабочем дереве он воссоздаётся,
> снимает снимок и **сразу удаляется**: харнес читает живую БД, ему нельзя попадать в коммит.
> Пример на .NET (NUnit); в другом стеке те же пять шагов.

## Пять шагов, которые нельзя пропускать

1. **Конфигурация как в приложении** — те же файлы настроек, тот же порядок наложения.
   Отличие в конфиге даёт снимок, который не соответствует ничему реальному.
2. **Тот же запрос, что в продакшн-коде** — не «похожий» SQL и не урезанный запрос.
   Снимок должен содержать то, что видит рабочий код.
3. **Материализация ленивых коллекций** перед сериализацией — иначе в JSON попадёт тип
   итератора вместо данных, и round-trip развалится.
4. **Round-trip тут же**: сериализовать → десериализовать теми же опциями. Не проверил —
   узнаешь о битом снимке через неделю, на непонятном падении теста.
5. **Запись в каталог фикстур** по конвенции имён проекта.

## Скелет

```csharp
// Временный [Explicit] харнес: снимок сущности из БД в JSON-фикстуру.
// Воссоздать -> снять -> УДАЛИТЬ. В коммит не уходит.
[TestFixture, Explicit("Локальный запуск: снимок из БД в фикстуру")]
public class FixtureCapture
{
    // каталог настроек приложения относительно тест-сборки
    static string AppDir => Path.GetFullPath(Path.Combine(
        TestContext.CurrentContext.TestDirectory, "..", "..", "..", "..", "src", "WebAPI"));

    [TestCase(2617310)]
    public async Task Capture(int entityId)
    {
        // 1. конфигурация как в приложении
        var config = new ConfigurationBuilder()
            .AddJsonFile(Path.Combine(AppDir, "appsettings.json"), optional: false)
            .AddJsonFile(Path.Combine(AppDir, "appsettings.Development.json"), optional: false)
            .Build();

        var services = new ServiceCollection();
        services.AddSingleton<IConfiguration>(config);
        services.AddLogging();
        services.AddMemoryCache();
        // ... регистрации того же состава, что в приложении
        await using var provider = services.BuildServiceProvider();

        // 2. тот же запрос, что делает продакшн-код
        var entity = await provider.GetRequiredService<IMediator>()
            .Send(new GetEntityQuery { Id = entityId, Extended = true });

        // 3. материализовать ленивые коллекции (иначе битый round-trip)
        Materialize(entity);

        // 4. round-trip контроль теми же опциями, которыми снимок будет читаться
        var json = JsonSerializer.Serialize(entity, Fixtures.JsonOptions);
        JsonSerializer.Deserialize<Entity>(json, Fixtures.JsonOptions);

        // 5. запись в каталог фикстур
        var dir = Path.GetFullPath(Path.Combine(
            TestContext.CurrentContext.TestDirectory, "..", "..", "..", "Fixtures"));
        File.WriteAllText(Path.Combine(dir, $"entity_{entityId}.json"), json);
    }
}
```

## Опции сериализации (пример состава)

Держать в одном месте рядом с helper'ом загрузки — **одни и те же** при записи и чтении:

```csharp
public static readonly JsonSerializerOptions JsonOptions = new()
{
    ReferenceHandler = ReferenceHandler.Preserve,   // граф с обратными/общими ссылками
    IncludeFields = true,                           // состояние в полях, не только в свойствах
    TypeInfoResolver = new DefaultJsonTypeInfoResolver
    {
        Modifiers =
        {
            ConfigurePolymorphism,                  // дискриминаторы на уровне опций, не атрибутами
            ReincludeIgnoredSettableProperties,     // вернуть [JsonIgnore] поля состояния
        }
    }
};
```

Про последний модификатор: помеченное `[JsonIgnore]` свойство попадает в модель типа с
обнулёнными get/set и внутренним флагом игнора — вернуть делегаты недостаточно. Нужно
**выбросить игнор-заглушку и добавить свежее рабочее свойство**, и только для read+write
свойств: вычисляемые get-only восстановятся сами.

## Запуск и уборка

```
dotnet test --filter "FullyQualifiedName~FixtureCapture"
```

Нужны доступ к БД и креды в локальных настройках. После записи снимка **файл харнеса удалить**
и проверить `git status` — в коммит он попасть не должен.
