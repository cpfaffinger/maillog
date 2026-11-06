import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { Role } from '../api/models';
import { AuthService } from './auth.service';

/** Requires a signed-in user; with roles, additionally one of those roles. */
export const roleGuard =
  (...roles: Role[]): CanActivateFn =>
  async (_route, state) => {
    const auth = inject(AuthService);
    const router = inject(Router);
    const user = await auth.ensureLoaded();
    if (!user) return router.createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
    if (roles.length > 0 && !roles.includes(user.role)) {
      return router.createUrlTree([AuthService.homeFor(user.role)]);
    }
    return true;
  };

export const homeGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const user = await auth.ensureLoaded();
  return router.createUrlTree([user ? AuthService.homeFor(user.role) : '/login']);
};
