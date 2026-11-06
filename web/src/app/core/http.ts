import { HttpContextToken, HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { AuthService } from './auth.service';
import { Notify } from './notify.service';

/** Requests flagged SILENT handle their errors themselves (no snackbar, no redirect on 401). */
export const SILENT = new HttpContextToken<boolean>(() => false);

export function errorMessage(e: unknown): string {
  if (e instanceof HttpErrorResponse) {
    const body: unknown = e.error;
    if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
      return body.error;
    }
    if (typeof body === 'string' && body.length > 0 && body.length < 200) return body;
    if (e.status === 0) return 'Server not reachable';
    if (e.status === 429) return 'Too many attempts, try again later';
    if (e.status === 403) return 'You are not allowed to do that';
    return e.statusText || `HTTP ${e.status}`;
  }
  return e instanceof Error ? e.message : 'Unexpected error';
}

export const apiInterceptor: HttpInterceptorFn = (req, next) => {
  const router = inject(Router);
  const auth = inject(AuthService);
  const notify = inject(Notify);
  return next(req).pipe(
    catchError((e: unknown) => {
      if (e instanceof HttpErrorResponse && !req.context.get(SILENT)) {
        if (e.status === 401) {
          auth.clear();
          if (!router.url.startsWith('/login')) {
            void router.navigate(['/login'], { queryParams: { returnUrl: router.url } });
          }
        } else {
          notify.error(errorMessage(e));
        }
      }
      return throwError(() => e);
    }),
  );
};
