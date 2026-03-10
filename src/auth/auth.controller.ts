import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { LogoutDto } from './dto/logout.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @ApiOperation({ summary: 'Register a new user' })
  @ApiBody({ type: RegisterDto })
  @ApiOkResponse({
    description: 'Newly created user and JWT tokens',
  })
  async register(@Body() dto: RegisterDto) {
    const { user, tokens } = await this.authService.register(dto);
    return {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        created_at: user.created_at,
      },
      tokens,
    };
  }

  @Post('login')
  @ApiOperation({ summary: 'Log in with email and password' })
  @ApiBody({ type: LoginDto })
  @ApiOkResponse({
    description: 'Authenticated user and JWT tokens',
  })
  async login(@Body() dto: LoginDto) {
    const { user, tokens } = await this.authService.login(dto);
    return {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        created_at: user.created_at,
      },
      tokens,
    };
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Refresh access token using a refresh token' })
  @ApiBody({ type: RefreshDto })
  @ApiOkResponse({
    description: 'User and refreshed JWT tokens',
  })
  async refresh(@Body() dto: RefreshDto) {
    const { user, tokens } = await this.authService.refresh(dto.refreshToken);
    return {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        created_at: user.created_at,
      },
      tokens,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Log out current session or a specific session' })
  @ApiBody({ type: LogoutDto })
  @ApiOkResponse({
    description: 'Logout success flag',
  })
  async logout(@Req() req: Request, @Body() dto: LogoutDto) {
    const user = req.user as { sub: string };
    await this.authService.logout(dto.sessionId ?? null, user.sub);
    return { success: true };
  }
}
