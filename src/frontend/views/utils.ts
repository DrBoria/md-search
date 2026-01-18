// Добавляю функцию для получения целой строки без украшений
export function getLineFromSource(
  source: string | undefined,
  start: number,
  end: number
): string {
  if (!source || start === undefined || end === undefined) {
    return ''
  }

  try {
    // Находим начало строки с совпадением
    const lineStart = source.lastIndexOf('\n', start - 1) + 1

    // Находим конец строки с совпадением
    let lineEnd = source.indexOf('\n', start)
    if (lineEnd === -1) {
      lineEnd = source.length
    }

    // Возвращаем текст строки без обрезки
    return source.substring(lineStart, lineEnd)
  } catch (e) {
    return ''
  }
}
