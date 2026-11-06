import { Pipe, PipeTransform } from '@angular/core';
import { fmtAgo, fmtDuration, fmtTime } from './util';

@Pipe({ name: 'ts' })
export class TsPipe implements PipeTransform {
  transform(ms: number | null | undefined): string {
    return fmtTime(ms);
  }
}

@Pipe({ name: 'dur' })
export class DurPipe implements PipeTransform {
  transform(sec: number | null | undefined): string {
    return fmtDuration(sec);
  }
}

@Pipe({ name: 'ago' })
export class AgoPipe implements PipeTransform {
  transform(ms: number | null | undefined, now?: number): string {
    return fmtAgo(ms, now);
  }
}
